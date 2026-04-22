import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL?.toLowerCase() ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export default logger;
