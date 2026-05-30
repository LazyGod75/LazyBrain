import pino from 'pino';
import { getConfig } from './config.js';

let cached: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (cached) return cached;
  const cfg = getConfig();
  cached = pino({
    level: cfg.logLevel,
    base: { app: 'lazybrain' },
    transport:
      process.stderr.isTTY && cfg.logLevel === 'debug'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
  return cached;
}

export function resetLoggerForTests(): void {
  cached = null;
}
