import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

import crypto from 'crypto';

const supabaseAuth = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userEmail?: string;
  clinicaId?: string;
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Token de autenticação obrigatório' });
      return;
    }

    const token = authHeader.substring(7);
    if (!token || token.length < 10) {
      res.status(401).json({ error: 'Token inválido' });
      return;
    }

    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Token expirado ou inválido' });
      return;
    }

    req.userId = data.user.id;
    req.userEmail = data.user.email;

    const { data: clinica } = await supabaseAuth
      .from('clinicas')
      .select('id')
      .eq('user_id', data.user.id)
      .single();

    if (clinica) req.clinicaId = clinica.id;

    next();
  } catch (err) {
    res.status(401).json({ error: 'Erro na autenticação' });
  }
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!env.NOTIFICATION_API_KEY) { next(); return; }
  const key = req.headers['x-api-key'] as string;
  if (!key || key.length !== env.NOTIFICATION_API_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(env.NOTIFICATION_API_KEY))) {
    res.status(403).json({ error: 'API key inválida' });
    return;
  }
  next();
}
