import { Router, Request, Response } from 'express';
import { supabase, limparConversasAntigas } from '../db/client';
import { enviarMensagem } from '../whatsapp/client';
import { requireApiKey } from '../middleware/auth';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const router = Router();

/** Send 24h reminder notifications. Call via external cron every hour. */
router.get('/api/notifications/process', requireApiKey, async (_req: Request, res: Response) => {
  try {
    const agora = new Date();
    const em24h = new Date(agora.getTime() + 24 * 3600000);
    const em23h = new Date(agora.getTime() + 23 * 3600000);

    const { data: ags } = await supabase.from('agendamentos')
      .select('*, profissionais(nome), clinicas(nome, phone_number_id, bot_nome)')
      .eq('status', 'confirmado').gte('data_hora', em23h.toISOString()).lte('data_hora', em24h.toISOString());

    if (!ags || ags.length === 0) { res.json({ sent: 0 }); return; }

    let enviados = 0;
    for (const a of ags) {
      const { data: ex } = await supabase.from('notificacoes').select('id')
        .eq('agendamento_id', a.id).eq('tipo', 'lembrete_24h').eq('enviado', true).limit(1);
      if (ex && ex.length > 0) continue;

      const bn = (a.clinicas as any)?.bot_nome || 'Bia';
      const cn = (a.clinicas as any)?.nome || 'Clínica';
      const inst = (a.clinicas as any)?.phone_number_id;
      if (!inst || !a.paciente_telefone) continue;

      const dt = a.data_hora?.substring(0, 10) || '';
      const hr = a.data_hora?.substring(11, 16) || '';
      const pn = (a.profissionais as any)?.nome || '';
      const msg = `Oi! Aqui é a ${bn} da ${cn}\n\nLembrete da sua consulta amanhã:\n${pn}\n${dt.split('-').reverse().join('/')}\n${hr}\n\nVai poder comparecer? Responda SIM ou NÃO.`;

      try {
        const sent = await enviarMensagem(a.paciente_telefone, msg, inst);
        await supabase.from('notificacoes').insert({
          clinica_id: a.clinica_id, agendamento_id: a.id, tipo: 'lembrete_24h',
          telefone: a.paciente_telefone, mensagem: msg, enviado: sent,
          enviado_at: sent ? new Date().toISOString() : null,
        });
        if (sent) enviados++;
      } catch (e) {
        await supabase.from('notificacoes').insert({
          clinica_id: a.clinica_id, agendamento_id: a.id, tipo: 'lembrete_24h',
          telefone: a.paciente_telefone, mensagem: msg, enviado: false,
        });
      }
    }
    res.json({ sent: enviados, total: ags.length });
  } catch (e) {
    logger.error('Notifications error', { error: (e as Error).message });
    res.status(500).json({ error: 'Erro' });
  }
});

/** Cleanup stale conversations. Call via cron every 6 hours. */
router.get('/api/cleanup/conversas', requireApiKey, async (_req: Request, res: Response) => {
  try {
    const hours = env.CONVERSATION_TIMEOUT_HOURS;

    // Cache de info da clínica pra não fazer N+1 query no callback
    const clinicaInfo = new Map<string, { nome: string; botNome: string; instance: string } | null>();
    let avisados = 0;

    const cleaned = await limparConversasAntigas(hours, async (conv) => {
      let info = clinicaInfo.get(conv.clinica_id);
      if (info === undefined) {
        const { data: cl } = await supabase.from('clinicas')
          .select('nome, bot_nome, phone_number_id').eq('id', conv.clinica_id).single();
        info = cl?.phone_number_id
          ? { nome: cl.nome || 'Clínica', botNome: cl.bot_nome || 'Bia', instance: cl.phone_number_id }
          : null;
        clinicaInfo.set(conv.clinica_id, info);
      }
      if (!info || !conv.paciente_telefone) return;

      const msg = `Oi! Aqui é a ${info.botNome} da ${info.nome}. Sua conversa anterior expirou — se precisar de algo, é só me chamar de novo que começamos do zero! 😊`;
      try {
        await enviarMensagem(conv.paciente_telefone, msg, info.instance);
        avisados++;
      } catch (e) {
        logger.warn('Falha ao avisar paciente sobre cleanup', { error: (e as Error).message });
      }
    });

    logger.info('Conversas limpas', { cleaned, avisados, hoursOld: hours });
    res.json({ cleaned, avisados, hoursThreshold: hours });
  } catch (e) {
    logger.error('Cleanup error', { error: (e as Error).message });
    res.status(500).json({ error: 'Erro' });
  }
});

export default router;
