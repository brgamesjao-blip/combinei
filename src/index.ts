import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';
import whatsappWebhook, { drainPendingBatches } from './whatsapp/webhook';
import onboardingRoutes from './onboarding/routes';
import evolutionRoutes from './evolution/routes';
import notificationRoutes from './notifications/routes';
import exportRoutes from './export/routes';
import cacheRoutes from './cache/routes';

const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// CORS - skip for webhook and health routes
const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/health' || req.path === '/') {
    return next();
  }
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  })(req, res, next);
});

// Health
app.get('/', (_req, res) => { res.json({ name: 'Combinei Bot', status: 'online', v: '6.0' }); });
app.get('/health', async (_req, res) => {
  try {
    const { supabase } = await import('./db/client');
    const { error } = await supabase.from('clinicas').select('id').limit(1);
    res.json({ status: 'healthy', db: error ? 'error' : 'ok', ts: new Date().toISOString() });
  } catch { res.status(503).json({ status: 'unhealthy' }); }
});

// Routes
app.use(whatsappWebhook);
app.use(onboardingRoutes);
app.use(evolutionRoutes);
app.use(notificationRoutes);
app.use(exportRoutes);
app.use(cacheRoutes);

app.use(errorHandler);

const port = Number(env.PORT) || 3000;
const server = app.listen(port, '0.0.0.0', () => { logger.info('Server started', { port, env: env.NODE_ENV }); });

// Graceful shutdown — wait for in-flight batches before exiting
async function shutdown(signal: string) {
  logger.info('Shutdown signal received', { signal });
  server.close();
  try {
    await drainPendingBatches(15000);
    logger.info('Shutdown completo, saindo');
  } catch (e) {
    logger.error('Erro no shutdown', { error: (e as Error).message });
  }
  process.exit(0);
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
