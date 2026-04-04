import { Router, Response } from 'express';
import { supabase } from '../db/client';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';

const router = Router();

function san(str: unknown, max = 200): string { if (!str || typeof str !== 'string') return ''; return str.trim().substring(0, max); }

router.post('/api/onboarding/clinica', requireAuth, apiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const nome = san(req.body.nome, 100); if (!nome || nome.length < 2) { res.status(400).json({ ok: false, error: 'Nome obrigatório' }); return; }
    const { data, error } = await supabase.from('clinicas').insert({ user_id: req.userId, nome, telefone: san(req.body.telefone, 20), horario_abertura: san(req.body.horario_abertura, 5) || '08:00', horario_fechamento: san(req.body.horario_fechamento, 5) || '18:00', ativa: true }).select().single();
    if (error) throw error;
    res.json({ ok: true, clinica: data });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/onboarding/profissional', requireAuth, apiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const cid = san(req.body.clinica_id, 64), nome = san(req.body.nome, 100), esp = san(req.body.especialidade, 100);
    if (!cid || !nome || !esp) { res.status(400).json({ ok: false, error: 'Campos obrigatórios' }); return; }
    const { data: cl } = await supabase.from('clinicas').select('id').eq('id', cid).eq('user_id', req.userId).single();
    if (!cl) { res.status(403).json({ ok: false, error: 'Sem permissão' }); return; }
    const { data, error } = await supabase.from('profissionais').insert({ clinica_id: cid, nome, especialidade: esp, ativo: true }).select().single();
    if (error) throw error;
    res.json({ ok: true, profissional: data });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/onboarding/servico', requireAuth, apiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const cid = san(req.body.clinica_id, 64), nome = san(req.body.nome, 100);
    if (!cid || !nome) { res.status(400).json({ ok: false, error: 'Campos obrigatórios' }); return; }
    const { data: cl } = await supabase.from('clinicas').select('id').eq('id', cid).eq('user_id', req.userId).single();
    if (!cl) { res.status(403).json({ ok: false, error: 'Sem permissão' }); return; }
    const dur = Math.min(Math.max(Number(req.body.duracao_minutos) || 30, 5), 480);
    const preco = req.body.preco ? Math.min(Number(req.body.preco), 99999) : null;
    const { data, error } = await supabase.from('servicos').insert({ clinica_id: cid, nome, duracao_minutos: dur, preco, ativo: true }).select().single();
    if (error) throw error;
    res.json({ ok: true, servico: data });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
