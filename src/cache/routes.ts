import { Router, Response } from 'express';
import { supabase } from '../db/client';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { clinicaCache, profsCache, servsCache } from '../utils/cache';
import { logger } from '../utils/logger';

const router = Router();

/** Invalidate cache for a specific clinic — called by dashboard after saving changes */
router.post('/api/cache/invalidate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { clinicaId } = req.body;
    if (!clinicaId || typeof clinicaId !== 'string') {
      res.status(400).json({ error: 'clinicaId obrigatório' });
      return;
    }

    // Verify ownership before invalidating
    const { data: cl } = await supabase
      .from('clinicas')
      .select('id, phone_number_id')
      .eq('id', clinicaId)
      .eq('user_id', req.userId)
      .single();

    if (!cl) {
      res.status(403).json({ error: 'Sem permissão' });
      return;
    }

    if (cl.phone_number_id) clinicaCache.invalidate(cl.phone_number_id);
    profsCache.invalidate(cl.id);
    servsCache.invalidate(cl.id);

    logger.info('Cache invalidado', { clinicaId });
    res.json({ ok: true });
  } catch (e) {
    logger.error('Erro invalidando cache', { error: (e as Error).message });
    res.status(500).json({ error: 'Erro' });
  }
});

export default router;
