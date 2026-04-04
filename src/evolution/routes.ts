import { Router, Response } from 'express';
import { env } from '../config/env';
import { supabase } from '../db/client';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { evolutionLimiter } from '../middleware/rateLimit';
import { logger } from '../utils/logger';

const router = Router();

function safeId(name: unknown): string | null {
  if (!name || typeof name !== 'string') return null;
  const clean = name.replace(/[^a-zA-Z0-9\-_]/g, '').substring(0, 64);
  return clean.length >= 2 ? clean : null;
}

/** Build webhook config — ALWAYS includes auth header */
function buildWebhookConfig() {
  const webhookUrl = env.WEBHOOK_URL || 'https://combinei-production.up.railway.app/webhook';
  return {
    url: webhookUrl,
    enabled: true,
    byEvents: false,
    base64: false,
    events: ['MESSAGES_UPSERT'],
    headers: env.WEBHOOK_SECRET ? { apikey: env.WEBHOOK_SECRET } : undefined,
  };
}

router.post('/evolution/create-instance', requireAuth, evolutionLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { clinicaId, instanceName } = req.body;
    const safeName = safeId(instanceName);
    if (!clinicaId || !safeName) { res.status(400).json({ error: 'clinicaId e instanceName obrigatórios' }); return; }

    const { data: cl } = await supabase.from('clinicas').select('id').eq('id', clinicaId).eq('user_id', req.userId).single();
    if (!cl) { res.status(403).json({ error: 'Sem permissão' }); return; }

    // Delete old instance if exists
    try {
      await fetch(`${env.EVOLUTION_API_URL}/instance/delete/${safeName}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'apikey': env.EVOLUTION_API_KEY },
      });
    } catch {}

    await new Promise(r => setTimeout(r, 2000));

    // Create new instance WITH webhook auth
    const createResponse = await fetch(`${env.EVOLUTION_API_URL}/instance/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': env.EVOLUTION_API_KEY },
      body: JSON.stringify({
        instanceName: safeName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        webhook: buildWebhookConfig(),
      }),
    });
    const data = await createResponse.json();

    // Also explicitly set webhook (belt + suspenders)
    try {
      await fetch(`${env.EVOLUTION_API_URL}/webhook/set/${safeName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': env.EVOLUTION_API_KEY },
        body: JSON.stringify({ webhook: buildWebhookConfig() }),
      });
    } catch {}

    // Update clinic record
    await supabase.from('clinicas').update({
      phone_number_id: safeName,
      whatsapp_token: 'evolution',
    }).eq('id', clinicaId);

    logger.info('Instância criada', { instance: safeName, clinicaId });
    res.json({ success: true, instance: data });
  } catch (e) {
    logger.error('Erro criar instância', { error: (e as Error).message });
    res.status(500).json({ error: 'Erro ao criar instância' });
  }
});

router.get('/evolution/qrcode/:instanceName', requireAuth, evolutionLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const n = safeId(req.params.instanceName);
    if (!n) { res.status(400).json({ error: 'Invalid' }); return; }
    const r = await fetch(`${env.EVOLUTION_API_URL}/instance/connect/${n}`, {
      headers: { 'apikey': env.EVOLUTION_API_KEY },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: 'Erro QR' });
  }
});

router.get('/evolution/status/:instanceName', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const n = safeId(req.params.instanceName);
    if (!n) { res.status(400).json({ error: 'Invalid' }); return; }
    const r = await fetch(`${env.EVOLUTION_API_URL}/instance/connectionState/${n}`, {
      headers: { 'apikey': env.EVOLUTION_API_KEY },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: 'Erro status' });
  }
});

router.delete('/evolution/instance/:instanceName', requireAuth, evolutionLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const n = safeId(req.params.instanceName);
    if (!n) { res.status(400).json({ error: 'Invalid' }); return; }
    const r = await fetch(`${env.EVOLUTION_API_URL}/instance/delete/${n}`, {
      method: 'DELETE',
      headers: { 'apikey': env.EVOLUTION_API_KEY },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: 'Erro delete' });
  }
});

/** Reconnect webhook — use if bot stops responding */
router.post('/evolution/fix-webhook/:instanceName', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const n = safeId(req.params.instanceName);
    if (!n) { res.status(400).json({ error: 'Invalid' }); return; }
    const r = await fetch(`${env.EVOLUTION_API_URL}/webhook/set/${n}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': env.EVOLUTION_API_KEY },
      body: JSON.stringify({ webhook: buildWebhookConfig() }),
    });
    const data = await r.json();
    logger.info('Webhook reconfigurado', { instance: n });
    res.json({ success: true, webhook: data });
  } catch (e) {
    logger.error('Erro fix webhook', { error: (e as Error).message });
    res.status(500).json({ error: 'Erro ao reconfigurar webhook' });
  }
});

export default router;
