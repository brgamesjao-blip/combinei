import { Router, Request, Response } from 'express';
import { enviarMensagem } from './client';
import { processarMensagem, criarContextoInicial } from '../ai/engine';
import { buscarConversa, salvarConversa, limparConversa, criarAgendamento, cancelarAgendamentoPaciente, marcarHandoff, supabase, getOcupadosPorProfissional } from '../db/client';
import { Clinica, HorarioDisponivel } from '../types';
import { validateWebhook } from '../middleware/validateWebhook';
import { webhookLimiter } from '../middleware/rateLimit';
import { logger } from '../utils/logger';
import { clinicaCache, profsCache, servsCache } from '../utils/cache';

const router = Router();

// Idempotency: deduplicate messages (5 min TTL)
const processedMessages = new Map<string, number>();
setInterval(() => { const cut = Date.now() - 300000; for (const [k, v] of processedMessages) { if (v < cut) processedMessages.delete(k); } }, 60000);

router.post('/webhook', webhookLimiter, validateWebhook, async (req: Request, res: Response) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body.event || body.event !== 'messages.upsert') return;
    const data = body.data;
    if (!data?.key || data.key.fromMe) return;

    // Idempotency
    const messageId = data.key.id;
    if (messageId && processedMessages.has(messageId)) return;
    if (messageId) processedMessages.set(messageId, Date.now());

    const instanceName = body.instance;
    const remoteJid = data.key.remoteJid || '';
    if (remoteJid.includes('@g.us')) return;
    const phone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
    if (!phone) return;

    let texto = '';
    if (data.message) texto = data.message.conversation || data.message.extendedTextMessage?.text || '';
    if (!texto) return;

    logger.info('Msg recebida', { phone, instance: instanceName });

    // ── Load clinic data (WITH CACHE) ──
    let clinicaRow = clinicaCache.get(instanceName);
    if (!clinicaRow) {
      const { data: byInst } = await supabase.from('clinicas').select('*').eq('phone_number_id', instanceName).eq('ativa', true).single();
      clinicaRow = byInst;
      if (!clinicaRow) {
        const { data: first } = await supabase.from('clinicas').select('*').eq('ativa', true).limit(1).single();
        clinicaRow = first;
      }
      if (clinicaRow) clinicaCache.set(instanceName, clinicaRow);
    }
    if (!clinicaRow) return;

    // Cached professionals & services
    let profs = profsCache.get(clinicaRow.id);
    if (!profs) {
      const { data: p } = await supabase.from('profissionais').select('*').eq('clinica_id', clinicaRow.id).eq('ativo', true);
      profs = p || [];
      profsCache.set(clinicaRow.id, profs);
    }

    let servs = servsCache.get(clinicaRow.id);
    if (!servs) {
      const { data: s } = await supabase.from('servicos').select('*').eq('clinica_id', clinicaRow.id).eq('ativo', true);
      servs = s || [];
      servsCache.set(clinicaRow.id, servs);
    }

    // ── Build clinic object (with configurable working days) ──
    const diasAtendimento: number[] = clinicaRow.dias_atendimento || [1, 2, 3, 4, 5]; // default seg-sex

    const horarioBase = { inicio: clinicaRow.horario_abertura || '08:00', fim: clinicaRow.horario_fechamento || '18:00' };
    const diasNomes = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    const horFunc: Record<string, { inicio: string; fim: string } | null> = {};
    diasNomes.forEach((d, i) => { horFunc[d] = diasAtendimento.includes(i) ? horarioBase : null; });

    const clinica: Clinica = {
      id: clinicaRow.id, nome: clinicaRow.nome, telefone: clinicaRow.telefone || '',
      botNome: clinicaRow.bot_nome || 'Bia',
      msgSaudacao: clinicaRow.msg_saudacao || null, msgConfirmacao: clinicaRow.msg_confirmacao || null,
      msgCancelamento: clinicaRow.msg_cancelamento || null, msgForaHorario: clinicaRow.msg_fora_horario || null,
      msgSemHorario: clinicaRow.msg_sem_horario || null,
      diasAtendimento,
      profissionais: profs.map((p: any) => ({ id: p.id, nome: p.nome, especialidade: p.especialidade, servicos: [] })),
      servicos: servs.map((s: any) => ({ id: s.id, nome: s.nome, duracaoMinutos: s.duracao_minutos, preco: s.preco })),
      horarioFuncionamento: horFunc,
    };

    // ── Load conversation state ──
    const salva = await buscarConversa(clinica.id, phone);
    const ctx = criarContextoInicial(clinica);
    if (salva) {
      // If in handoff, don't process with bot
      if (salva.etapa === 'handoff_humano') {
        logger.info('Conversa em handoff, ignorando bot', { phone });
        return;
      }
      ctx.etapa = salva.etapa;
      ctx.dadosColetados = salva.dadosColetados;
      ctx.historicoMensagens = salva.historicoMensagens;
    }

    // ── Generate available slots (supports Saturday) ──
    ctx.horariosOferecidos = gerarHorarios(
      clinicaRow.horario_abertura, clinicaRow.horario_fechamento,
      clinicaRow.almoco_inicio, clinicaRow.almoco_fim, diasAtendimento
    );

    // ── Filter folgas and occupied slots ──
    const hoje = new Date();
    const hojeStr = hoje.toISOString().split('T')[0];
    const fimStr = new Date(hoje.getTime() + 14 * 86400000).toISOString().split('T')[0];

    const [folgasR, ocupadosR, antigosR] = await Promise.all([
      supabase.from('folgas').select('data, profissional_id').eq('clinica_id', clinica.id).gte('data', hojeStr),
      getOcupadosPorProfissional(clinica.id, hojeStr + 'T00:00:00', fimStr + 'T23:59:59'),
      supabase.from('agendamentos').select('*, profissionais(nome)').eq('clinica_id', clinica.id).eq('paciente_telefone', phone).order('created_at', { ascending: false }).limit(5),
    ]);

    // Filter folgas (only remove day if ALL professionals are on leave)
    if (folgasR.data && folgasR.data.length > 0) {
      ctx.horariosOferecidos = ctx.horariosOferecidos.filter((dia) => {
        const pf = folgasR.data!.filter((f: any) => f.data === dia.data);
        return pf.length < clinica.profissionais.length;
      });
    }

    // Multi-professional filter: only remove slot if ALL professionals are occupied at that time
    if (ocupadosR.length > 0) {
      ctx.horariosOferecidos = filtrarOcupadosMultiProf(ctx.horariosOferecidos, ocupadosR, clinica.profissionais.length);
    }

    // Patient history
    let hist: string | undefined;
    const antigos = antigosR.data || [];
    if (antigos.length > 0) {
      hist = antigos.map((a: any) => `- ${a.paciente_nome || 'Paciente'} com ${(a.profissionais as any)?.nome || '?'} em ${new Date(a.data_hora).toLocaleDateString('pt-BR')}`).join('\n');
    }

    // ── Process with AI ──
    const resultado = await processarMensagem(texto, ctx, hist);

    // ── Handle special states AFTER AI response ──

    // CANCELAMENTO: only execute AFTER AI confirms (not on first intent)
    // FIX #5: Look for cancellation confirmation in AI response, not just intent
    if (resultado.contexto.dadosColetados.intencao === 'cancelar' &&
        (resultado.resposta.toLowerCase().includes('cancelad') || resultado.resposta.toLowerCase().includes('desmarcad'))) {
      const cancelled = await cancelarAgendamentoPaciente(clinica.id, phone);
      if (cancelled) {
        logger.info('Agendamento cancelado via bot', { phone, clinica: clinica.nome });
      }
      // FIX #4: Send response, clear conversation, and RETURN (don't re-save)
      await enviarMensagem(phone, resultado.resposta, instanceName);
      await limparConversa(clinica.id, phone);
      return;
    }

    // HANDOFF: mark for human and stop bot
    if (resultado.contexto.etapa === 'handoff_humano') {
      await marcarHandoff(clinica.id, phone); // FIX #3: This already inserts notification
      logger.info('Handoff para humano', { phone, clinica: clinica.nome });
      await enviarMensagem(phone, resultado.resposta, instanceName);
      return; // Don't save normal conversation state
    }

    // Save conversation
    await salvarConversa(clinica.id, phone, {
      etapa: resultado.contexto.etapa,
      dadosColetados: resultado.contexto.dadosColetados as Record<string, unknown>,
      historicoMensagens: resultado.contexto.historicoMensagens,
    });

    // Send response
    await enviarMensagem(phone, resultado.resposta, instanceName);

    // ── Create appointment if concluded ──
    if (resultado.contexto.etapa === 'agendamento_concluido') {
      try {
        const d = resultado.contexto.dadosColetados;
        const prof = clinica.profissionais.find(p => {
          const np = p.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const b = (d.profissional || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (np.includes(b) || b.includes(np)) return true;
          const words = b.replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/i, '').split(/\s+/).filter(Boolean);
          return words.length > 0 && words.every(w => np.includes(w));
        });
        const serv = clinica.servicos.find(s => (d.servico || '').toLowerCase().includes(s.nome.toLowerCase()));
        const duracao = serv ? serv.duracaoMinutos : (clinica.servicos[0]?.duracaoMinutos || 30);
        const dt = resolverDataHora(d.data, d.horario);
        if (dt && prof) {
          await criarAgendamento({ clinicaId: clinica.id, profissionalId: prof.id, pacienteNome: d.pacienteNome || 'Paciente', pacienteTelefone: phone, dataHora: dt, duracaoMinutos: duracao });
          await limparConversa(clinica.id, phone);
          logger.info('Agendamento salvo', { clinica: clinica.nome });
        }
      } catch (e) { logger.error('Erro agendamento', { error: (e as Error).message }); }
    }
  } catch (e) { logger.error('Webhook error', { error: (e as Error).message }); }
});

router.get('/webhook', (_: Request, res: Response) => { res.json({ status: 'ok' }); });

// ──────── Helper Functions ────────

function gerarHorarios(ab?: string, fe?: string, ai?: string, af?: string, diasAtend: number[] = [1,2,3,4,5]): HorarioDisponivel[] {
  const hI = parseInt((ab || '08:00').split(':')[0]), hF = parseInt((fe || '18:00').split(':')[0]);
  const hAI = parseInt((ai || '12:00').split(':')[0]), hAF = parseInt((af || '13:00').split(':')[0]);
  const dias: HorarioDisponivel[] = [];
  const nomes = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];
  const hoje = new Date();
  for (let i = 1; i <= 14; i++) { // FIX #11: 14 dias em vez de 7
    const d = new Date(hoje.getTime() + i * 86400000);
    if (!diasAtend.includes(d.getDay())) continue; // Configurable working days!
    const horarios: string[] = [];
    for (let h = hI; h < hF; h++) { if (h >= hAI && h < hAF) continue; horarios.push(String(h).padStart(2, '0') + ':00'); horarios.push(String(h).padStart(2, '0') + ':30'); }
    dias.push({ data: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, diaSemana: nomes[d.getDay()], horarios });
  }
  return dias;
}

/** Multi-professional: only remove slot if ALL professionals are busy at that time */
function filtrarOcupadosMultiProf(horarios: HorarioDisponivel[], ocupados: any[], totalProfs: number): HorarioDisponivel[] {
  if (totalProfs <= 0) return horarios; // FIX #12: guard 0 profs

  // Count how many professionals are busy at each slot
  const slotCount: Record<string, number> = {};
  ocupados.forEach(e => {
    // FIX #2: Extract time from ISO string directly (timezone-safe)
    // data_hora format: "2026-04-05T09:00:00-03:00" — we want "09:00", not UTC getHours()
    const iso = String(e.data_hora);
    const dateStr = iso.substring(0, 10);              // "2026-04-05"
    const timeStr = iso.substring(11, 16);             // "09:00"
    const key = `${dateStr}_${timeStr}`;
    slotCount[key] = (slotCount[key] || 0) + 1;
  });

  return horarios.map(dia => ({
    ...dia,
    horarios: dia.horarios.filter(h => {
      const key = `${dia.data}_${h}`;
      return (slotCount[key] || 0) < totalProfs; // Only remove if ALL profs are busy
    }),
  })).filter(dia => dia.horarios.length > 0);
}

function resolverDataHora(data?: string, horario?: string): string | null {
  if (!horario && !data) return null;
  const hoje = new Date();
  let alvo: Date | null = null;
  if (!data) alvo = new Date(hoje.getTime() + 86400000);
  else if (data.match(/^\d{4}-\d{2}-\d{2}$/)) alvo = new Date(data + 'T12:00:00');
  else if (data.match(/\d{2}\/\d{2}/)) { const m = data.match(/(\d{2})\/(\d{2})/); if (m) alvo = new Date(hoje.getFullYear(), +m[2] - 1, +m[1]); }
  else if (data.match(/dia\s*(\d{1,2})/i)) { const m = data.match(/dia\s*(\d{1,2})/i); if (m) { alvo = new Date(hoje.getFullYear(), hoje.getMonth(), +m[1]); if (alvo <= hoje) alvo.setMonth(alvo.getMonth() + 1); } }
  else {
    const map: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, 'terça': 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, 'sábado': 6 };
    const dl = data.toLowerCase().replace('-feira', '').trim();
    if (dl === 'amanha' || dl === 'amanhã') alvo = new Date(hoje.getTime() + 86400000);
    else if (dl === 'depois de amanha' || dl === 'depois de amanhã') alvo = new Date(hoje.getTime() + 2 * 86400000);
    else if (dl === 'hoje') alvo = new Date(hoje);
    else if (dl === 'semana que vem') { alvo = new Date(hoje); let d2 = 1 - hoje.getDay(); if (d2 <= 0) d2 += 7; alvo.setDate(hoje.getDate() + d2); }
    else { const t = map[dl]; if (t !== undefined) { alvo = new Date(hoje); let df = t - hoje.getDay(); if (df <= 0) df += 7; alvo.setDate(hoje.getDate() + df); } }
  }
  if (!alvo) return null;
  let h = '09', mn = '00';
  if (horario) {
    const fm = horario.match(/(\d{1,2}):(\d{2})/);
    if (fm) { h = fm[1].padStart(2, '0'); mn = fm[2]; }
    else { const sm = horario.match(/(\d{1,2})/); if (sm) { let hr = +sm[1]; if (horario.toLowerCase().includes('tarde') || horario.toLowerCase().includes('noite')) { if (hr < 12) hr += 12; } else if (!horario.toLowerCase().includes('manhã') && !horario.toLowerCase().includes('manha')) { if (hr <= 6) hr += 12; } h = String(hr).padStart(2, '0'); } if (horario.toLowerCase().includes('meia') || horario.toLowerCase().includes('30')) mn = '30'; }
  }
  return `${alvo.getFullYear()}-${String(alvo.getMonth() + 1).padStart(2, '0')}-${String(alvo.getDate()).padStart(2, '0')}T${h}:${mn}:00-03:00`;
}

export default router;
