/**
 * src/utils/config.ts
 * Loads and validates environment variables.
 * Throws on startup if required values are missing.
 */


// Note: .env is loaded by START.sh via shell export.
// For programmatic usage, call `loadEnvFile()` below if needed.

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
  botName: optional('BOT_NAME', 'kungbi-spider') as string,

  // Bot avatar URL for Discord notifications
  botAvatarUrl: optional('BOT_AVATAR_URL', 'https://github.com/kungbi-spider.png') as string,

  // GitHub username to poll review requests for
  githubReviewer: optional('GH_REVIEWER', 'backend-woongbi') as string,

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

  // Claude CLI timeout for the review subagent (minutes → ms)
  reviewTimeoutMs: optionalInt('REVIEW_TIMEOUT_MIN', 20) * 60 * 1000,
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
}

export default config;
