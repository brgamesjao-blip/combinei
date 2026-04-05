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

// Brazil timezone helper — Railway runs in UTC, Brazil is UTC-3
function getBrazilNow(): Date {
  const now = new Date();
  return new Date(now.getTime() - 3 * 3600000);
}

// Idempotency: deduplicate messages (5 min TTL)
const processedMessages = new Map<string, number>();
setInterval(() => { const cut = Date.now() - 300000; for (const [k, v] of processedMessages) { if (v < cut) processedMessages.delete(k); } }, 60000);

// ── Message batching: accumulate rapid-fire messages before processing ──
const pendingBatches = new Map<string, {
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
  instanceName: string;
  pushName: string;
}>();
const BATCH_DELAY_MS = 3000; // Wait 3s for more messages before processing

router.post('/webhook', webhookLimiter, validateWebhook, async (req: Request, res: Response) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body.event) return;
    const evt = body.event.toLowerCase().replace(/_/g, '.');
    if (evt !== 'messages.upsert') return;
    const data = body.data;
    if (!data?.key || data.key.fromMe) return;

    // Idempotency
    const messageId = data.key.id;
    if (messageId && processedMessages.has(messageId)) return;
    if (messageId) processedMessages.set(messageId, Date.now());

    const instanceName = typeof body.instance === 'object' ? (body.instance?.instanceName || body.instance?.name || '') : (body.instance || '');
    const remoteJid = data.key.remoteJid || '';
    if (remoteJid.includes('@g.us')) return;
    const phone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
    if (!phone) return;

    // ── Extract text (with media support) ──
    let texto = '';
    if (data.message) {
      texto = data.message.conversation || data.message.extendedTextMessage?.text || '';
      // Image/video with caption
      if (!texto && data.message.imageMessage?.caption) texto = data.message.imageMessage.caption;
      if (!texto && data.message.videoMessage?.caption) texto = data.message.videoMessage.caption;
      // Media without text — let AI respond appropriately
      if (!texto) {
        if (data.message.audioMessage) texto = '[O paciente enviou um áudio]';
        else if (data.message.imageMessage) texto = '[O paciente enviou uma imagem]';
        else if (data.message.videoMessage) texto = '[O paciente enviou um vídeo]';
        else if (data.message.stickerMessage) texto = '[O paciente enviou uma figurinha]';
        else if (data.message.documentMessage) texto = '[O paciente enviou um documento]';
      }
    }
    if (!texto) return;

    const pushName = data.pushName || '';
    logger.info('Msg recebida', { phone, instance: instanceName });

    // ── Batch messages: wait BATCH_DELAY_MS for more messages before processing ──
    const batchKey = `${instanceName}:${phone}`;
    const existing = pendingBatches.get(batchKey);

    if (existing) {
      // Add to existing batch, reset timer
      existing.texts.push(texto);
      if (!existing.pushName && pushName) existing.pushName = pushName;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        pendingBatches.delete(batchKey);
        processarLote(phone, existing.texts, existing.instanceName, existing.pushName).catch(e =>
          logger.error('Batch processing error', { error: (e as Error).message, phone })
        );
      }, BATCH_DELAY_MS);
    } else {
      // Create new batch
      const batch: { texts: string[]; timer: ReturnType<typeof setTimeout>; instanceName: string; pushName: string } = {
        texts: [texto],
        instanceName,
        pushName,
        timer: setTimeout(() => {
          pendingBatches.delete(batchKey);
          processarLote(phone, batch.texts, batch.instanceName, batch.pushName).catch(e =>
            logger.error('Batch processing error', { error: (e as Error).message, phone })
          );
        }, BATCH_DELAY_MS),
      };
      pendingBatches.set(batchKey, batch);
    }
  } catch (e) { logger.error('Webhook error', { error: (e as Error).message }); }
});

// ── Process a batch of messages from the same user ──
async function processarLote(phone: string, texts: string[], instanceName: string, pushName: string = '') {
  try {
    await processarLoteInner(phone, texts, instanceName, pushName);
  } catch (e) {
    logger.error('Erro fatal no processarLote', { error: (e as Error).message, phone });
    // Ensure patient always gets a response, even on unexpected errors
    try {
      await enviarMensagem(phone, 'Desculpa, tive um probleminha aqui. Pode tentar de novo em alguns segundos?', instanceName);
    } catch {}
  }
}

async function processarLoteInner(phone: string, texts: string[], instanceName: string, pushName: string = '') {
  let texto = texts.length === 1 ? texts[0] : texts.join('\n');

  if (texts.length > 1) {
    logger.info('Batch processado', { phone, msgCount: texts.length });
  }

  // ── Load clinic data (WITH CACHE) ──
  let clinicaRow = clinicaCache.get(instanceName);
  if (!clinicaRow) {
    const { data: byInst } = await supabase.from('clinicas').select('*').eq('phone_number_id', instanceName).eq('ativa', true).single();
    clinicaRow = byInst;
    // Fallback ONLY if there's exactly 1 active clinic (dev/single-tenant scenario)
    // Never route to a random clinic when multiple exist — security risk
    if (!clinicaRow) {
      const { data: all } = await supabase.from('clinicas').select('*').eq('ativa', true).limit(2);
      if (all && all.length === 1) {
        clinicaRow = all[0];
      }
    }
    if (clinicaRow) clinicaCache.set(instanceName, clinicaRow);
  }
  if (!clinicaRow) {
    logger.warn('Webhook sem clínica correspondente', { instance: instanceName });
    return;
  }

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
  const diasAtendimento: number[] = clinicaRow.dias_atendimento || [1, 2, 3, 4, 5];

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
  let staleNote = '';
  if (salva) {
    if (salva.etapa === 'handoff_humano') {
      logger.info('Conversa em handoff, ignorando bot', { phone });
      return;
    }
    ctx.etapa = salva.etapa;
    ctx.dadosColetados = salva.dadosColetados;
    ctx.historicoMensagens = salva.historicoMensagens;

    // Detect stale conversation (gap > 2 hours) — note goes in system prompt, not in message history
    if (salva.updatedAt) {
      const gap = Date.now() - new Date(salva.updatedAt).getTime();
      if (gap > 2 * 3600000) {
        const hoursAgo = Math.floor(gap / 3600000);
        staleNote = `ATENÇÃO: O paciente voltou após ${hoursAgo}h sem responder. Cumprimente novamente e pergunte se quer continuar o agendamento anterior ou começar de novo.`;
        logger.info('Conversa retomada após gap', { phone, hoursAgo });
      }
    }
  }

  // ── Generate available slots ──
  ctx.horariosOferecidos = gerarHorarios(
    clinicaRow.horario_abertura, clinicaRow.horario_fechamento,
    clinicaRow.almoco_inicio, clinicaRow.almoco_fim, diasAtendimento
  );

  // ── Filter folgas and occupied slots ──
  const hoje = getBrazilNow();
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

  // Patient history — mark future vs past vs cancelled so AI knows actual state
  let hist: string | undefined;
  const antigos = antigosR.data || [];
  if (antigos.length > 0) {
    const nowMs = Date.now();
    hist = antigos.map((a: any) => {
      const dt = new Date(a.data_hora);
      const dateStr = dt.toLocaleDateString('pt-BR');
      const timeStr = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      let tag: string;
      if (a.status === 'cancelado') tag = '[CANCELADO]';
      else if (dt.getTime() > nowMs && a.status === 'confirmado') tag = '[AGENDADO FUTURO]';
      else tag = '[PASSADO]';
      return `- ${tag} ${a.paciente_nome || 'Paciente'} com ${(a.profissionais as any)?.nome || '?'} em ${dateStr} às ${timeStr}`;
    }).join('\n');
  }

  // ── Build additional context (stale note, pushName) for system prompt ──
  let histFinal = hist || '';
  if (staleNote) {
    histFinal = staleNote + (histFinal ? '\n\n' + histFinal : '');
  }
  if (pushName && !ctx.dadosColetados.pacienteNome) {
    histFinal = (histFinal ? histFinal + '\n\n' : '') +
      'Nome no perfil do WhatsApp deste paciente: ' + pushName +
      '. Ao pedir o nome completo, sugira: "Seu nome é ' + pushName + '?" — se confirmar, use sem pedir de novo.';
  }

  // ── Process with AI ──
  const resultado = await processarMensagem(texto, ctx, histFinal || undefined);

  // Guard: if AI returned empty response, use fallback to avoid sending empty message
  if (!resultado.resposta || resultado.resposta.trim().length === 0) {
    logger.warn('Resposta vazia do AI, usando fallback', { phone });
    resultado.resposta = 'Desculpa, tive um probleminha aqui. Pode repetir?';
  }

  // If AI confirmed an appointment, extract the ACTUAL prof name from response
  // (protects against stale/wrong profissional in dadosColetados)
  if (resultado.contexto.etapa === 'agendamento_concluido') {
    const respNormalized = resultado.resposta.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const matchedProf = clinica.profissionais.find(p => {
      const np = p.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (respNormalized.includes(np)) return true;
      // Try individual words (e.g. response says "Ana" for "Dra. Ana Silva")
      const words = np.replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/, '').split(/\s+/).filter(w => w.length > 2);
      return words.length > 0 && words.some(w => respNormalized.includes(w));
    });
    if (matchedProf) {
      resultado.contexto.dadosColetados.profissional = matchedProf.nome;
    }
  }

  // ── Handle special states AFTER AI response ──

  // CANCELAMENTO: only execute AFTER AI confirms
  if (resultado.contexto.dadosColetados.intencao === 'cancelar' &&
      (resultado.resposta.toLowerCase().includes('cancelad') || resultado.resposta.toLowerCase().includes('desmarcad'))) {
    const cancelled = await cancelarAgendamentoPaciente(clinica.id, phone);
    if (cancelled) {
      logger.info('Agendamento cancelado via bot', { phone, clinica: clinica.nome });
    }
    await enviarMensagem(phone, resultado.resposta, instanceName);
    await limparConversa(clinica.id, phone);
    return;
  }

  // REMARCAÇÃO: cancel existing appointment, continue with new booking flow
  if (resultado.contexto.dadosColetados.intencao === 'remarcar') {
    const cancelled = await cancelarAgendamentoPaciente(clinica.id, phone);
    if (cancelled) {
      logger.info('Agendamento anterior cancelado para remarcação', { phone, clinica: clinica.nome });
    }
  }

  // HANDOFF: mark for human and stop bot
  if (resultado.contexto.etapa === 'handoff_humano') {
    await marcarHandoff(clinica.id, phone);
    logger.info('Handoff para humano', { phone, clinica: clinica.nome });
    await enviarMensagem(phone, resultado.resposta, instanceName);
    return;
  }

  // Save conversation (trim history to last 30 messages to prevent unbounded growth)
  await salvarConversa(clinica.id, phone, {
    etapa: resultado.contexto.etapa,
    dadosColetados: resultado.contexto.dadosColetados as Record<string, unknown>,
    historicoMensagens: resultado.contexto.historicoMensagens.slice(-30),
  });

  // Send response
  await enviarMensagem(phone, resultado.resposta, instanceName);

  // ── Create appointment if concluded ──
  if (resultado.contexto.etapa === 'agendamento_concluido') {
    try {
      const d = resultado.contexto.dadosColetados;
      logger.info('AGENDAMENTO INICIANDO', { profissional: String(d.profissional || ''), data: String(d.data || ''), horario: String(d.horario || ''), paciente: String(d.pacienteNome || ''), profsDB: clinica.profissionais.map(p => p.nome).join(', ') });

      let prof = clinica.profissionais.find(p => {
        const np = p.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const b = (d.profissional || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (!b) return false;
        if (np.includes(b) || b.includes(np)) return true;
        const words = b.replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/i, '').split(/\s+/).filter(Boolean);
        return words.length > 0 && words.every(w => np.includes(w));
      });
      // Fallback: if only 1 professional exists, use them
      if (!prof && clinica.profissionais.length === 1) prof = clinica.profissionais[0];
      // Fallback: if profissional name partially matches any
      if (!prof && d.profissional) {
        const bWords = (d.profissional || '').toLowerCase().replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/i, '').split(/\s+/).filter(Boolean);
        prof = clinica.profissionais.find(p => bWords.some(w => p.nome.toLowerCase().includes(w)));
      }

      const serv = clinica.servicos.find(s => (d.servico || '').toLowerCase().includes(s.nome.toLowerCase()));
      const duracao = serv ? serv.duracaoMinutos : (clinica.servicos[0]?.duracaoMinutos || 30);
      const dt = resolverDataHora(d.data, d.horario);

      logger.info('AGENDAMENTO RESOLVE', { dt: String(dt || 'NULL'), profFound: !!prof, profNome: String(prof?.nome || 'NONE') });

      if (dt && prof) {
        try {
          await criarAgendamento({ clinicaId: clinica.id, profissionalId: prof.id, pacienteNome: d.pacienteNome || pushName || 'Paciente', pacienteTelefone: phone, dataHora: dt, duracaoMinutos: duracao });
          await limparConversa(clinica.id, phone);
          logger.info('Agendamento salvo', { clinica: clinica.nome, prof: prof.nome, dt });
        } catch (err) {
          // Slot conflict or other DB error — notify patient so they know
          logger.warn('Conflito ao criar agendamento', { error: (err as Error).message, phone, dt });
          await enviarMensagem(phone, 'Ops, esse horário acabou de ser preenchido por outro paciente! Pode escolher outro horário?', instanceName);
        }
      } else {
        // Invalid prof/date — don't leave patient thinking they're booked
        logger.warn('AGENDAMENTO FALHOU', { dtNull: !dt, profNull: !prof, data: String(d.data || ''), horario: String(d.horario || ''), profissional: String(d.profissional || '') });
        await enviarMensagem(phone, 'Ops, tive um probleminha pra registrar seu agendamento. Pode me confirmar de novo o nome do profissional e o horário?', instanceName);
      }
    } catch (e) { logger.error('Erro agendamento', { error: (e as Error).message }); }
  }
}

router.get('/webhook', (_: Request, res: Response) => { res.json({ status: 'ok' }); });

// ──────── Helper Functions ────────

function gerarHorarios(ab?: string, fe?: string, ai?: string, af?: string, diasAtend: number[] = [1,2,3,4,5]): HorarioDisponivel[] {
  const hI = parseInt((ab || '08:00').split(':')[0]), hF = parseInt((fe || '18:00').split(':')[0]);
  const hAI = parseInt((ai || '12:00').split(':')[0]), hAF = parseInt((af || '13:00').split(':')[0]);
  const dias: HorarioDisponivel[] = [];
  const nomes = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];
  const hoje = getBrazilNow();
  const horaAtual = hoje.getHours();
  const minAtual = hoje.getMinutes();
  for (let i = 0; i <= 14; i++) { // Start from today (i=0)
    const d = new Date(hoje.getTime() + i * 86400000);
    if (!diasAtend.includes(d.getDay())) continue;
    const horarios: string[] = [];
    for (let h = hI; h < hF; h++) {
      if (h >= hAI && h < hAF) continue;
      const slots = [String(h).padStart(2, '0') + ':00', String(h).padStart(2, '0') + ':30'];
      for (const slot of slots) {
        // For today, skip past time slots
        if (i === 0) {
          const [sh, sm] = slot.split(':').map(Number);
          if (sh < horaAtual || (sh === horaAtual && sm <= minAtual)) continue;
        }
        horarios.push(slot);
      }
    }
    if (horarios.length > 0) {
      dias.push({ data: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, diaSemana: nomes[d.getDay()], horarios });
    }
  }
  return dias;
}

/** Multi-professional: only remove slot if ALL professionals are busy at that time */
function filtrarOcupadosMultiProf(horarios: HorarioDisponivel[], ocupados: any[], totalProfs: number): HorarioDisponivel[] {
  if (totalProfs <= 0) return horarios;

  const slotCount: Record<string, number> = {};
  ocupados.forEach(e => {
    const iso = String(e.data_hora);
    const dateStr = iso.substring(0, 10);
    const timeStr = iso.substring(11, 16);
    const duracao = e.duracao_minutos || 30;

    // Block all 30-min slots covered by this appointment's duration
    const [startH, startM] = timeStr.split(':').map(Number);
    let mins = startH * 60 + startM;
    const endMins = mins + duracao;
    while (mins < endMins) {
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      const key = `${dateStr}_${hh}:${mm}`;
      slotCount[key] = (slotCount[key] || 0) + 1;
      mins += 30;
    }
  });

  return horarios.map(dia => ({
    ...dia,
    horarios: dia.horarios.filter(h => {
      const key = `${dia.data}_${h}`;
      return (slotCount[key] || 0) < totalProfs;
    }),
  })).filter(dia => dia.horarios.length > 0);
}

function resolverDataHora(data?: string, horario?: string): string | null {
  if (!horario && !data) return null;
  const hoje = getBrazilNow();
  let alvo: Date | null = null;
  if (!data) alvo = new Date(hoje.getTime() + 86400000);
  else if (data.match(/^\d{4}-\d{2}-\d{2}$/)) alvo = new Date(data + 'T12:00:00');
  else if (data.match(/\d{2}\/\d{2}/)) {
    const m = data.match(/(\d{2})\/(\d{2})/);
    if (m) {
      alvo = new Date(hoje.getFullYear(), +m[2] - 1, +m[1]);
      // Compare by date only (not time) — same-day requests shouldn't bump
      const hojeDate = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
      if (alvo < hojeDate) alvo.setFullYear(alvo.getFullYear() + 1);
    }
  }
  else if (data.match(/dia\s*(\d{1,2})/i)) {
    const m = data.match(/dia\s*(\d{1,2})/i);
    if (m) {
      alvo = new Date(hoje.getFullYear(), hoje.getMonth(), +m[1]);
      // Compare by date only (not time) — same-day requests shouldn't bump
      const hojeDate = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
      if (alvo < hojeDate) alvo.setMonth(alvo.getMonth() + 1);
    }
  }
  else {
    const map: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, 'terça': 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, 'sábado': 6 };
    const dl = data.toLowerCase().replace(/[\s-]?feira/, '').trim();
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
