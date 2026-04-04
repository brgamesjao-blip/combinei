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
    // FIX #8: Timing-safe API key comparison
    if (apikey && apikey.length === env.WEBHOOK_SECRET.length &&
        crypto.timingSafeEqual(Buffer.from(apikey), Buffer.from(env.WEBHOOK_SECRET))) {
      next(); return;
    }

    const signature = req.headers['x-webhook-signature'] as string
      || req.headers['x-hub-signature-256'] as string;

    if (!signature) {
      res.status(401).json({ error: 'Missing webhook signature' });
      return;
    }

    try {
      const payload = JSON.stringify(req.body);
      const expected = crypto.createHmac('sha256', env.WEBHOOK_SECRET).update(payload).digest('hex');
      const sig = signature.replace('sha256=', '');
      // FIX #7: Check lengths before timingSafeEqual
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Signature verification failed' });
      return;
    }
  }

  next();
}
