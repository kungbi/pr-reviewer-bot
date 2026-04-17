import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'logs', 'bot.log');
const LOG_LEVELS: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase() ?? ''] ?? LOG_LEVELS.INFO;

function format(level: string, message: string): string {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').substring(0, 19);
  return `[${ts}] [${level}] ${message}`;
}

function write(level: string, ...args: unknown[]): void {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = format(level, msg);

  // File always gets everything
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_FILE, line + '\n');

  // Console only if at or above configured level
  if (LOG_LEVELS[level] <= currentLevel) {
    const stream = level === 'ERROR' ? process.stderr : process.stdout;
    stream.write(line + '\n');
  }
}

export default {
  error: (...args: unknown[]) => write('ERROR', ...args),
  warn:  (...args: unknown[]) => write('WARN',  ...args),
  info:  (...args: unknown[]) => write('INFO',  ...args),
  debug: (...args: unknown[]) => write('DEBUG', ...args),
};
