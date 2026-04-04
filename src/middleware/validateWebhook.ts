import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';

export function validateWebhook(req: Request, res: Response, next: NextFunction): void {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  if (env.WEBHOOK_SECRET) {
    const apikey = req.headers['apikey'] as string;
    if (!apikey) {
      res.status(401).json({ error: 'Missing webhook auth' });
      return;
    }
    try {
      const a = Buffer.from(apikey);
      const b = Buffer.from(env.WEBHOOK_SECRET);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'Invalid webhook auth' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Auth check failed' });
      return;
    }
  }

  next();
}
