const LOG_LEVELS: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase() ?? ''] ?? LOG_LEVELS.INFO;

function write(level: string, ...args: unknown[]): void {
  if (LOG_LEVELS[level] > currentLevel) return;
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${ts}] [${level}] ${msg}`;
  (level === 'ERROR' ? process.stderr : process.stdout).write(line + '\n');
}

export default {
  error: (...args: unknown[]) => write('ERROR', ...args),
  warn:  (...args: unknown[]) => write('WARN',  ...args),
  info:  (...args: unknown[]) => write('INFO',  ...args),
  debug: (...args: unknown[]) => write('DEBUG', ...args),
};
