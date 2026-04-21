import fs from 'fs';
import path from 'path';
import { parseLearnings, getQualityMetrics } from '../utils/learnings';

const STATE_FILE = path.join(__dirname, '../../state/reviewed-prs.json');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

interface PRStateEntry {
  reviewedAt?: string;
  [key: string]: unknown;
}

interface StateFileData {
  reviewedPRs?: Record<string, PRStateEntry>;
}

interface RecurringIssue {
  issue: string;
  count: number;
}

interface DailySummary {
  totalReviewed: number;
  todayReviewed: number;
  avgScore: number | null;
  avgReviewTimeMs: number | null;
  topIssues: RecurringIssue[];
  totalIterations: number;
}

interface DiscordField {
  name: string;
  value: string;
  inline: boolean;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: DiscordField[];
  timestamp: string;
  footer: { text: string };
  url?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendWebhook(payload: unknown): Promise<boolean> {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('[daily-summary] DISCORD_WEBHOOK_URL not set, skipping');
    return false;
  }
  const MAX_RETRIES = 3;
  let lastError: Error = new Error('No attempts made');
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        console.log(`[daily-summary] Discord webhook success (attempt ${attempt})`);
        return true;
      }
      const text = await response.text();
      lastError = new Error(`Discord API ${response.status}: ${text}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
  }
  console.error('[daily-summary] Discord webhook failed:', lastError.message);
  return false;
}

function loadReviewedPRs(): Record<string, PRStateEntry> {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw) as StateFileData;
    return data.reviewedPRs ?? {};
  } catch {
    return {};
  }
}

function getTodayPRs(reviewedPRs: Record<string, PRStateEntry>): Array<{ key: string } & PRStateEntry> {
  const todayStr = new Date().toISOString().split('T')[0];
  return Object.entries(reviewedPRs)
    .filter(([, entry]) => entry.reviewedAt?.startsWith(todayStr) ?? false)
    .map(([key, entry]) => ({ key, ...entry }));
}

function parseRecurringIssues(): RecurringIssue[] {
  const learnings = parseLearnings();
  const allText = learnings.map(l => l.text).join('\n');

  const patterns: Array<{ label: string; patterns: string[] }> = [
    { label: 'Security', patterns: ['security', 'injection', 'xss', 'csrf', 'auth bypass', 'sensitive data', 'sql injection'] },
    { label: 'Error Handling', patterns: ['error handling', 'exception', 'try-catch', 'missing catch', 'unhandled'] },
    { label: 'Performance', patterns: ['n+1', 'performance', 'memory leak', 'unnecessary loop', 'inefficient'] },
    { label: 'Code Quality', patterns: ['code duplication', 'dead code', 'naming', 'maintainability'] },
    { label: 'Testing', patterns: ['test', 'coverage', 'unit test', 'missing test'] },
    { label: 'Documentation', patterns: ['documentation', 'comment', 'readme', 'docstring'] },
    { label: 'Validation', patterns: ['validation', 'null check', 'undefined', 'type check'] },
    { label: 'Race Condition', patterns: ['race condition', 'concurrent', 'async', 'deadlock'] },
  ];

  const counts: Record<string, number> = {};
  for (const { label, patterns: kwList } of patterns) {
    let count = 0;
    for (const kw of kwList) {
      const matches = allText.match(new RegExp(kw, 'gi'));
      if (matches) count += matches.length;
    }
    if (count > 0) counts[label] = count;
  }

  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([issue, count]) => ({ issue, count }));
}

function generateDailySummary(): DailySummary {
  const reviewedPRs = loadReviewedPRs();
  const allPRs = Object.values(reviewedPRs);
  const todayPRs = getTodayPRs(reviewedPRs);
  const { averageQuality, totalIterations } = getQualityMetrics();

  const learnings = parseLearnings();
  let avgReviewTimeMs: number | null = null;

  if (learnings.length >= 2) {
    const sorted = learnings
      .map(l => new Date(l.timestamp).getTime())
      .sort((a, b) => a - b);
    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalGap += sorted[i] - sorted[i - 1];
    }
    avgReviewTimeMs = Math.round(totalGap / (sorted.length - 1));
  }

  return {
    totalReviewed: allPRs.length,
    todayReviewed: todayPRs.length,
    avgScore: averageQuality ? parseFloat(averageQuality) : null,
    avgReviewTimeMs,
    topIssues: parseRecurringIssues(),
    totalIterations,
  };
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return 'N/A';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function buildEmbed({ title, description, color, fields = [], url }: {
  title: string;
  description: string;
  color: number;
  fields?: DiscordField[];
  url?: string;
}): DiscordEmbed {
  const embed: DiscordEmbed = {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: '🕷️ Kungbi PR Reviewer Bot' },
  };
  if (url) embed.url = url;
  return embed;
}

function buildSummaryEmbed(summary: DailySummary): DiscordEmbed {
  const { totalReviewed, todayReviewed, avgScore, avgReviewTimeMs, topIssues } = summary;
  const today = new Date().toISOString().split('T')[0];

  const fields: DiscordField[] = [
    { name: '📊 Total PRs Reviewed', value: String(totalReviewed), inline: true },
    { name: '🕷️ Reviewed Today', value: String(todayReviewed), inline: true },
    { name: '⏱️ Avg Review Time', value: formatDuration(avgReviewTimeMs), inline: true },
  ];

  if (avgScore !== null) {
    fields.push({ name: '⭐ Average Quality Score', value: `${avgScore}/10`, inline: true });
  }

  const issueValue = topIssues.length > 0
    ? topIssues.map(({ issue, count }) => `**${issue}** (${count}x)`).join('\n')
    : 'No patterns detected yet';

  fields.push({ name: '🔍 Top 3 Recurring Issues', value: issueValue, inline: false });

  return buildEmbed({
    title: `📋 Daily Review Summary — ${today}`,
    description: `Daily summary of all PR reviews completed by **kungbi-spider**.`,
    color: 0x7C3AED,
    fields,
  });
}

async function sendDailySummary(): Promise<boolean> {
  const summary = generateDailySummary();
  const embed = buildSummaryEmbed(summary);

  const payload = {
    username: 'Kungbi PR Reviewer',
    avatar_url: 'https://github.com/kungbi-spider.png',
    embeds: [embed],
  };

  const success = await sendWebhook(payload);

  if (success) {
    console.log(`[daily-summary] Summary sent: ${summary.todayReviewed} PRs today, ${summary.totalReviewed} total`);
  } else {
    console.error('[daily-summary] Failed to send summary to Discord');
  }

  return success;
}

if (require.main === module) {
  sendDailySummary()
    .then(success => process.exit(success ? 0 : 1))
    .catch(err => {
      console.error('[daily-summary] Unhandled error:', err);
      process.exit(1);
    });
}

export {
  generateDailySummary,
  sendDailySummary,
  buildSummaryEmbed,
};
