/**
 * Daily Summary Generator
 *
 * Generates and sends a daily summary of all PR reviews to Discord.
 *
 * Reads from:
 *  - state/reviewed-prs.json   → total PRs reviewed
 *  - data/progress.txt          → quality scores and learnings
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseLearnings, getQualityMetrics } = require('./learnings');

// ─── Discord Webhook Helper (duplicated from discord-notifier) ───────────────

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('[daily-summary] DISCORD_WEBHOOK_URL not set, skipping');
    return false;
  }
  const MAX_RETRIES = 3;
  let lastError;
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
      lastError = err;
    }
    if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
  }
  console.error('[daily-summary] Discord webhook failed:', lastError.message);
  return false;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, '..');
// Match path used by polling-reviewer.js (the active writer)
const STATE_FILE = path.join(PROJECT_ROOT, 'state', 'reviewed-prs.json');
const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'progress.txt');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read and parse the reviewed-PRs state file.
 * Returns an array of PR entry objects.
 */
function loadReviewedPRs() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data.reviewedPRs || {};
  } catch {
    return {};
  }
}

/**
 * Read raw progress file (learnings entries).
 */
function loadProgress() {
  try {
    if (!fs.existsSync(PROGRESS_FILE)) return '';
    return fs.readFileSync(PROGRESS_FILE, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Get all PRs reviewed today (UTC).
 * Returns array of { key, ...entry } objects.
 */
function getTodayPRs(reviewedPRs) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD (UTC)

  return Object.entries(reviewedPRs)
    .filter(([, entry]) => {
      if (!entry.reviewedAt) return false;
      return entry.reviewedAt.startsWith(todayStr);
    })
    .map(([key, entry]) => ({ key, ...entry }));
}

/**
 * Parse recurring issue patterns from all learnings text.
 * Looks for keywords/patterns to identify common issue types.
 * Returns array of { issue, count } sorted by frequency.
 */
function parseRecurringIssues() {
  const learnings = parseLearnings();
  const allText = learnings.map(l => l.text).join('\n');

  // Common issue patterns to look for
  const patterns = [
    { label: 'Security', patterns: ['security', 'injection', 'xss', 'csrf', 'auth bypass', 'sensitive data', 'sql injection'] },
    { label: 'Error Handling', patterns: ['error handling', 'exception', 'try-catch', 'missing catch', 'unhandled'] },
    { label: 'Performance', patterns: ['n+1', 'performance', 'memory leak', 'unnecessary loop', 'inefficient'] },
    { label: 'Code Quality', patterns: ['code duplication', 'dead code', 'naming', 'maintainability'] },
    { label: 'Testing', patterns: ['test', 'coverage', 'unit test', 'missing test'] },
    { label: 'Documentation', patterns: ['documentation', 'comment', 'readme', 'docstring'] },
    { label: 'Validation', patterns: ['validation', 'null check', 'undefined', 'type check'] },
    { label: 'Race Condition', patterns: ['race condition', 'concurrent', 'async', 'deadlock'] },
  ];

  const counts = {};
  for (const { label, patterns: kwList } of patterns) {
    let count = 0;
    for (const kw of kwList) {
      const regex = new RegExp(kw, 'gi');
      const matches = allText.match(regex);
      if (matches) count += matches.length;
    }
    if (count > 0) {
      counts[label] = count;
    }
  }

  // Sort by count descending, take top 3
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([issue, count]) => ({ issue, count }));
}

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Generate the daily summary object.
 * Returns { totalReviewed, avgScore, avgReviewTimeMs, topIssues, todayCount, totalCount }
 */
function generateDailySummary() {
  const reviewedPRs = loadReviewedPRs();
  const allPRs = Object.values(reviewedPRs);

  const todayPRs = getTodayPRs(reviewedPRs);
  const { averageQuality, totalIterations } = getQualityMetrics();

  // Average review time: try to estimate from learnings timestamps
  const learnings = parseLearnings();
  let avgReviewTimeMs = null;

  if (learnings.length >= 2) {
    // Sort by timestamp and calculate avg gap between iterations
    const sorted = learnings
      .map(l => new Date(l.timestamp).getTime())
      .sort((a, b) => a - b);

    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalGap += sorted[i] - sorted[i - 1];
    }
    avgReviewTimeMs = Math.round(totalGap / (sorted.length - 1));
  }

  // Recurring issues
  const topIssues = parseRecurringIssues();

  // Build summary
  return {
    totalReviewed: allPRs.length,
    todayReviewed: todayPRs.length,
    avgScore: averageQuality ? parseFloat(averageQuality) : null,
    avgReviewTimeMs,
    topIssues,
    totalIterations,
  };
}

/**
 * Format a duration in milliseconds to human-readable string.
 */
function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'N/A';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * Build a Discord embed for the daily summary.
 */
/**
 * Build a Discord embed for the daily summary.
 */
function buildEmbed({ title, description, color, fields = [], url = '' }) {
  const embed = {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: '🕷️ Kungbi PR Reviewer Bot',
    },
  };
  if (url) embed.url = url;
  return embed;
}

/**
 * Build a Discord embed for the daily summary.
 */
function buildSummaryEmbed(summary) {
  const {
    totalReviewed,
    todayReviewed,
    avgScore,
    avgReviewTimeMs,
    topIssues,
  } = summary;

  const today = new Date().toISOString().split('T')[0];

  const fields = [
    {
      name: '📊 Total PRs Reviewed',
      value: String(totalReviewed),
      inline: true,
    },
    {
      name: '🕷️ Reviewed Today',
      value: String(todayReviewed),
      inline: true,
    },
    {
      name: '⏱️ Avg Review Time',
      value: formatDuration(avgReviewTimeMs),
      inline: true,
    },
  ];

  if (avgScore !== null) {
    fields.push({
      name: '⭐ Average Quality Score',
      value: `${avgScore}/10`,
      inline: true,
    });
  }

  if (topIssues.length > 0) {
    const issueList = topIssues
      .map(({ issue, count }) => `**${issue}** (${count}x)`)
      .join('\n');
    fields.push({
      name: '🔍 Top 3 Recurring Issues',
      value: issueList,
      inline: false,
    });
  } else {
    fields.push({
      name: '🔍 Top 3 Recurring Issues',
      value: 'No patterns detected yet',
      inline: false,
    });
  }

  return buildEmbed({
    title: `📋 Daily Review Summary — ${today}`,
    description: `Daily summary of all PR reviews completed by **kungbi-spider**.`,
    color: 0x7C3AED, // Purple
    fields,
  });
}

/**
 * Send the daily summary to Discord.
 * @returns {Promise<boolean>} Success status
 */
async function sendDailySummary() {
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

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

if (require.main === module) {
  // Allow custom state/progress paths via env for the cron script
  if (process.env.STATE_FILE) {
    const original = STATE_FILE;
    require('fs').existsSync(process.env.STATE_FILE) && void 0;
  }

  sendDailySummary()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(err => {
      console.error('[daily-summary] Unhandled error:', err);
      process.exit(1);
    });
}

module.exports = {
  generateDailySummary,
  sendDailySummary,
  buildSummaryEmbed,
};
