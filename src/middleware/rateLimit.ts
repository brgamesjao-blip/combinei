import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry { count: number; resetAt: number; }
const stores = new Map<string, Map<string, RateLimitEntry>>();

export function rateLimit(opts: { windowMs: number; max: number; keyPrefix?: string }) {
  const { windowMs, max, keyPrefix = 'default' } = opts;
  if (!stores.has(keyPrefix)) stores.set(keyPrefix, new Map());
  const store = stores.get(keyPrefix)!;

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 300000);

  return function (req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = store.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.status(429).json({ error: 'Muitas requisições. Tente novamente em alguns segundos.' });
      return;
    }
    next();
  };
}

export const webhookLimiter = rateLimit({ windowMs: 60000, max: 60, keyPrefix: 'webhook' });
export const apiLimiter = rateLimit({ windowMs: 60000, max: 30, keyPrefix: 'api' });
export const evolutionLimiter = rateLimit({ windowMs: 60000, max: 10, keyPrefix: 'evolution' });
