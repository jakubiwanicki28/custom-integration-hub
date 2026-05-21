import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.isDev ? 'debug' : 'info',
  ...(config.isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
});

export function createLogger(name: string) {
  return logger.child({ integration: name });
}
