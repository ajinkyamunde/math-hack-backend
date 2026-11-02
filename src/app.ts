import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { getRequestListener } from '@hono/node-server';
import { corsOptions } from './config/cors.js';
import { getEnv } from './config/environment.js';
import { csrfProtection } from './middleware/csrfProtection.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { apiRoutes } from './routes/index.js';
import { honoApp } from './realtime/honoApp.js';

export function createApp(): Express {
  const env = getEnv();
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors(corsOptions()));

  const honoListener = getRequestListener(honoApp.fetch);

  // Mount Hono for the competition realtime & standardized Hono endpoints
  // Specifically: /api/competitions/:id/events, /start-test, /my-session, /status, /open-registration, /start, /submit, /complete, /questions
  app.use('/api', (req, res, next) => {
    const url = req.url || '';
    if (
      url.includes('/events') ||
      url.includes('/start-test') ||
      url.includes('/my-session') ||
      url.includes('/open-registration') ||
      (url.startsWith('/competitions/') && (
        url.endsWith('/status') ||
        url.endsWith('/start') ||
        url.endsWith('/submit') ||
        url.endsWith('/complete') ||
        url.endsWith('/questions')
      ))
    ) {
      return honoListener(req, res);
    }
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    res.status(dbReady ? 200 : 503).json({ status: dbReady ? 'ok' : 'degraded', database: dbReady ? 'connected' : 'disconnected', time: new Date().toISOString() });
  });

  app.use('/api', apiLimiter(), csrfProtection, apiRoutes());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
