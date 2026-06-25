/**
 * src/utils/config.ts
 * Loads and validates environment variables.
 * Throws on startup if required values are missing.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

// Note: .env is loaded here with override=true so PM2's stale --update-env
// snapshot cannot keep an old REVIEW_AGENT/CODEX_MODEL after .env changes.
// For programmatic usage, call `loadEnvFile()` below if needed.

import { modelAgentMismatch, type ReviewAgent } from './agent-command';

// ── Helpers ──────────────────────────────────────────────────────────────────

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`[config] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, defaultValue: string | null): string | null {
  const value = process.env[name];
  return (value && value.trim() !== '') ? value.trim() : defaultValue;
}

function optionalInt(name: string, defaultValue: number): number {
  const raw = optional(name, String(defaultValue)) as string;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`[config] ${name} must be an integer, got: "${raw}"`);
  }
  return parsed;
}

function optionalBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === '') {
    return defaultValue;
  }
  return value.trim() === 'true' || value.trim() === '1';
}

// ── Config Object ─────────────────────────────────────────────────────────────

const VALID_LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

// ── Review agent (computed early so the model default can depend on it) ─────────
const VALID_REVIEW_AGENTS = ['claude', 'opencode', 'codex'] as const;

const reviewAgent: ReviewAgent = (() => {
  const value = (optional('REVIEW_AGENT', 'claude') as string).toLowerCase();
  if (!(VALID_REVIEW_AGENTS as readonly string[]).includes(value)) {
    throw new Error(
      `[config] REVIEW_AGENT must be one of ${VALID_REVIEW_AGENTS.join('|')}, got: "${value}"`
    );
  }
  return value as ReviewAgent;
})();

// Model passed to the review agent (review quality lever). The agents use
// different model formats, so each reads its own env var — switching REVIEW_AGENT
// alone is then safe, with no cross-format breakage:
//   - claude   reads REVIEW_MODEL   (short alias, e.g. "opus"; default "opus")
//   - opencode reads OPENCODE_MODEL ("provider/model", e.g. "google/gemini-2.5-flash";
//              unset → null → opencode uses its own configured default)
//   - codex    reads CODEX_MODEL    (bare name, e.g. "gpt-5.5", "gpt-5.2-codex";
//              unset → null → codex uses its own configured default)
const reviewModel: string | null = (() => {
  switch (reviewAgent) {
    case 'opencode': return optional('OPENCODE_MODEL', null);
    case 'codex':    return optional('CODEX_MODEL', null);
    default:         return optional('REVIEW_MODEL', 'opus'); // claude
  }
})();

// Fail loud on agent/model format mismatch. opencode exits 0 even on error, so a
// stale value (e.g. "opus" left in OPENCODE_MODEL, or "openai/.." in REVIEW_MODEL
// while still on claude) would otherwise silently produce empty reviews.
const modelMismatch = modelAgentMismatch(reviewAgent, reviewModel);
if (modelMismatch) {
  throw new Error(`[config] ${modelMismatch}`);
}

const config = {
  // GitHub — token is optional when `gh auth login` is already done
  ghToken: optional('GH_TOKEN', null),

  // Webhook HMAC secret (unused in polling mode, kept for compatibility)
  webhookSecret: optional('WEBHOOK_SECRET', null),

  // Discord incoming webhook URL (required for notifications)
  discordWebhookUrl: required('DISCORD_WEBHOOK_URL'),

  // Discord Bot Token for receiving manual review commands
  discordBotToken: optional('DISCORD_BOT_TOKEN', null),

  // Discord Channel ID to watch for manual review triggers
  discordChannelId: optional('DISCORD_CHANNEL_ID', null),

  // Bot display name
  botName: optional('BOT_NAME', 'pr-reviewer-bot') as string,

  // Bot avatar URL for Discord notifications
  botAvatarUrl: optional('BOT_AVATAR_URL', 'https://github.com/github.png') as string,

  // GitHub username to poll review requests for
  githubReviewer: optional('GH_REVIEWER', optional('GH_USERNAME', 'reviewer-github-username')) as string,

  // HTTP server port
  port: optionalInt('PORT', 3000),

  // Log level
  logLevel: (() => {
    const level = (optional('LOG_LEVEL', 'INFO') as string).toUpperCase();
    if (!VALID_LOG_LEVELS.includes(level)) {
      throw new Error(
        `[config] LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join('|')}, got: "${level}"`
      );
    }
    return level;
  })(),

  // Polling interval in seconds
  pollIntervalMin: optionalInt('POLL_INTERVAL_MIN', 5),

  // Repo-clone based PR review
  prCloneEnabled: optionalBool('PR_CLONE_ENABLED', true),
  prCloneDepth: optionalInt('PR_CLONE_DEPTH', 200),
  prCloneTimeoutMs: optionalInt('PR_CLONE_TIMEOUT_MS', 90000),

  // Review agent CLI timeout for the review subagent (minutes → ms)
  reviewTimeoutMs: optionalInt('REVIEW_TIMEOUT_MIN', 20) * 60 * 1000,

  // Which CLI coding agent is spawned for the review (claude | opencode)
  reviewAgent,

  // Model for the review agent (null → agent's own default). See note above.
  reviewModel,

  // Max PRs reviewed in parallel (caps memory from concurrent Opus subagents)
  reviewConcurrency: optionalInt('REVIEW_CONCURRENCY', 3),

  // Monitor replies to this bot's PR review comments and answer when needed
  replyMonitorEnabled: optionalBool('REPLY_MONITOR_ENABLED', true),
  replyMonitorLookbackDays: optionalInt('REPLY_MONITOR_LOOKBACK_DAYS', 14),

  // Days to keep completed PR entries in the state file before pruning
  stateRetentionDays: optionalInt('STATE_RETENTION_DAYS', 30),
};

// ── Startup Summary ──────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== 'test') {
  console.log('[config] Loaded configuration:');
  console.log(`  BOT_NAME       : ${config.botName}`);
  console.log(`  PORT           : ${config.port}`);
  console.log(`  LOG_LEVEL      : ${config.logLevel}`);
  console.log(`  POLL_INTERVAL  : ${config.pollIntervalMin}min`);
  console.log(`  GH_TOKEN       : ${config.ghToken ? '***set***' : '(using gh auth)'}`);
  console.log(`  WEBHOOK_SECRET : ***set***`);
  console.log(`  DISCORD_WEBHOOK: ***set***`);
  console.log(`  PR_CLONE_ENABLED    : ${config.prCloneEnabled}`);
  console.log(`  PR_CLONE_DEPTH      : ${config.prCloneDepth}`);
  console.log(`  PR_CLONE_TIMEOUT_MS : ${config.prCloneTimeoutMs}`);
  console.log(`  REVIEW_AGENT        : ${config.reviewAgent}`);
  console.log(`  REVIEW_MODEL        : ${config.reviewModel ?? '(agent default)'} (from ${config.reviewAgent === 'opencode' ? 'OPENCODE_MODEL' : config.reviewAgent === 'codex' ? 'CODEX_MODEL' : 'REVIEW_MODEL'})`);
  console.log(`  REVIEW_CONCURRENCY  : ${config.reviewConcurrency}`);
  console.log(`  REPLY_MONITOR       : ${config.replyMonitorEnabled}`);
  console.log(`  REPLY_LOOKBACK_DAYS : ${config.replyMonitorLookbackDays}`);
  console.log(`  STATE_RETENTION_DAYS: ${config.stateRetentionDays}`);
}

export default config;
