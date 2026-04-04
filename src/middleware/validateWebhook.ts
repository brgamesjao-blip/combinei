import { Request, Response, NextFunction } from 'express';

export function validateWebhook(req: Request, res: Response, next: NextFunction): void {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }
  next();
}