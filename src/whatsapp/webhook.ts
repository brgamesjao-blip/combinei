import { Router, Request, Response } from 'express';
import { enviarMensagem } from './client';
import { processarMensagem, criarContextoInicial } from '../ai/engine';
import { buscarConversa, salvarConversa, limparConversa, criarAgendamento, cancelarAgendamentoPaciente, listarAgendamentosFuturos, cancelarAgendamentoPorId, marcarHandoff, supabase, getOcupadosPorProfissional, AgendamentoFuturo } from '../db/client';
import { Clinica, HorarioDisponivel } from '../types';
import { validateWebhook } from '../middleware/validateWebhook';
import { webhookLimiter } from '../middleware/rateLimit';
import { logger } from '../utils/logger';
import { clinicaCache, profsCache, servsCache } from '../utils/cache';
import { matchProfissional, formatProfList } from '../utils/matchers';
import { parseHorario } from '../utils/parseHorario';
import { env } from '../config/env';
import crypto from 'crypto';

/** Tenta POST com retry exponencial (1s, 2s, 4s) e timeout 5s por tentativa. */
async function postDashboardWithRetry(url: string, payload: Record<string, unknown>, maxRetries = 3): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  logger.error('Dashboard webhook falhou após retries', {
    error: (lastError as Error)?.message || String(lastError),
    type: String(payload.type || ''),
    clinicaId: String(payload.clinicaId || ''),
  });
}

/** Fire-and-forget no caller — não bloqueia o flow do bot, mas tenta 3x e loga falha. */
function notifyDashboard(type: 'handoff' | 'emergency', clinicaId: string, phone: string, extra?: Record<string, unknown>): void {
  if (!env.DASHBOARD_WEBHOOK_URL) return;
  const payload = {
    type,
    clinicaId,
    phone,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  postDashboardWithRetry(env.DASHBOARD_WEBHOOK_URL, payload).catch(e =>
    logger.error('Dashboard notify error inesperado', { error: (e as Error).message })
  );
}

const router = Router();

// Brazil timezone helper — Railway runs in UTC, Brazil is UTC-3
function getBrazilNow(): Date {
  const now = new Date();
  return new Date(now.getTime() - 3 * 3600000);
}

// Emergency keywords — escalate immediately to human + recommend emergency services
const EMERGENCY_KEYWORDS = [
  'emergencia', 'socorro', 'urgente', 'urgencia',
  'dor forte', 'dor muito forte', 'muita dor',
  'nao consigo respirar', 'falta de ar',
  'desmaiei', 'desmaiando', 'desmaio',
  'sangrando muito', 'muito sangue',
  'ataque cardiaco', 'infarto', 'avc', 'derrame',
  'passando muito mal', 'muito mal'
];

function detectEmergency(text: string): boolean {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return EMERGENCY_KEYWORDS.some(kw => normalized.includes(kw));
}

const EMERGENCY_RESPONSE = 'Parece que é uma situação de emergência! 🚨\n\nPor favor, ligue AGORA para o SAMU: 192\nOu vá imediatamente ao pronto-socorro mais próximo.\n\nVou avisar nossa equipe também. Cuida de você!';

// Idempotency: deduplicate messages (5 min TTL)
const processedMessages = new Map<string, number>();
const MAX_PROCESSED = 50000;
function addProcessed(id: string): void {
  processedMessages.set(id, Date.now());
  // Hard cap pra evitar memory leak em picos. Map é insertion-ordered, então
  // deletar primeiras N chaves remove as mais antigas.
  if (processedMessages.size > MAX_PROCESSED) {
    let removed = 0;
    for (const k of processedMessages.keys()) {
      processedMessages.delete(k);
      if (++removed >= 10000) break;
    }
    logger.warn('processedMessages cap atingido', { removed, remaining: processedMessages.size });
  }
}
setInterval(() => { const cut = Date.now() - 300000; for (const [k, v] of processedMessages) { if (v < cut) processedMessages.delete(k); } }, 60000);

// ── Message batching: accumulate rapid-fire messages before processing ──
const pendingBatches = new Map<string, {
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
  instanceName: string;
  pushName: string;
}>();
const BATCH_DELAY_MS = 3000; // Wait 3s for more messages before processing
const MAX_BATCH_SIZE = 10; // Protect against spam / rapid-fire abuse

// Serialização por batchKey: garante que duas execuções de processarLote pro
// mesmo paciente NUNCA rodem em paralelo (evita salvarConversa concorrente
// e processamento fora de ordem quando uma msg chega durante o processing).
const batchProcessing = new Map<string, Promise<void>>();
function scheduleBatch(batchKey: string, fn: () => Promise<void>): void {
  const prev = batchProcessing.get(batchKey) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  batchProcessing.set(batchKey, next);
  next.finally(() => {
    if (batchProcessing.get(batchKey) === next) batchProcessing.delete(batchKey);
  });
}

// Track in-flight processing for graceful shutdown
let activeBatches = 0;
export async function drainPendingBatches(maxWaitMs = 15000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while ((pendingBatches.size > 0 || activeBatches > 0 || batchProcessing.size > 0) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
}

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
    if (messageId) addProcessed(messageId);

    const instanceName = typeof body.instance === 'object' ? (body.instance?.instanceName || body.instance?.name || '') : (body.instance || '');
    const remoteJid = data.key.remoteJid || '';
    // Mensagens não-DM: log + skip (em vez de silent drop pra ajudar debug)
    if (remoteJid.includes('@g.us')) {
      logger.warn('Mensagem de grupo ignorada', { remoteJid, instance: instanceName });
      return;
    }
    if (remoteJid.includes('status@broadcast') || remoteJid.includes('@broadcast')) {
      logger.debug('Status broadcast ignorado', { remoteJid });
      return;
    }
    if (remoteJid.includes('@newsletter')) {
      logger.debug('Newsletter ignorado', { remoteJid });
      return;
    }
    const phone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
    if (!phone) return;

    // ── Extract text (with media support) ──
    let texto = '';
    if (data.message) {
      // Tipos especiais: log + skip antes de tentar extrair texto
      if (data.message.reactionMessage) {
        logger.info('Reação ignorada', { phone, emoji: data.message.reactionMessage.text || '' });
        return;
      }
      if (data.message.protocolMessage) {
        // protocolMessage = mensagem deletada/editada/etc — ignorar silenciosamente após log
        logger.debug('protocolMessage ignorada', { phone, type: data.message.protocolMessage.type });
        return;
      }
      if (data.message.pollCreationMessage || data.message.pollUpdateMessage) {
        logger.info('Enquete ignorada', { phone });
        return;
      }
      if (data.message.editedMessage) {
        logger.info('Mensagem editada ignorada', { phone });
        return;
      }

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
        else if (data.message.locationMessage) texto = '[O paciente enviou uma localização]';
        else if (data.message.contactMessage) texto = '[O paciente enviou um contato]';
      }
    }
    if (!texto) {
      logger.debug('Mensagem sem texto ou tipo conhecido, ignorada', { phone, types: Object.keys(data.message || {}) });
      return;
    }
    // Proteção contra mensagens absurdamente longas (DoS / acidente)
    if (texto.length > 2000) {
      logger.warn('Mensagem truncada (>2000 chars)', { phone, originalLen: texto.length });
      texto = texto.substring(0, 2000);
    }

    const pushName = data.pushName || '';
    logger.info('Msg recebida', { phone, instance: instanceName });

    // ── Batch messages: wait BATCH_DELAY_MS for more messages before processing ──
    const batchKey = `${instanceName}:${phone}`;
    const existing = pendingBatches.get(batchKey);

    if (existing) {
      // Drop message if batch is already at max — protect against spam
      if (existing.texts.length >= MAX_BATCH_SIZE) {
        logger.warn('Batch cheio, mensagem descartada', { phone, size: existing.texts.length });
        return;
      }
      // Add to existing batch, reset timer
      existing.texts.push(texto);
      if (!existing.pushName && pushName) existing.pushName = pushName;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        pendingBatches.delete(batchKey);
        scheduleBatch(batchKey, () =>
          processarLote(phone, existing.texts, existing.instanceName, existing.pushName).catch(e =>
            logger.error('Batch processing error', { error: (e as Error).message, phone })
          )
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
          scheduleBatch(batchKey, () =>
            processarLote(phone, batch.texts, batch.instanceName, batch.pushName).catch(e =>
              logger.error('Batch processing error', { error: (e as Error).message, phone })
            )
          );
        }, BATCH_DELAY_MS),
      };
      pendingBatches.set(batchKey, batch);
    }
  } catch (e) { logger.error('Webhook error', { error: (e as Error).message }); }
});

// ── Process a batch of messages from the same user ──
async function processarLote(phone: string, texts: string[], instanceName: string, pushName: string = '') {
  const reqId = crypto.randomBytes(4).toString('hex');
  activeBatches++;
  try {
    await processarLoteInner(phone, texts, instanceName, pushName, reqId);
  } catch (e) {
    const errMsg = (e as Error).message?.toLowerCase() || '';
    const errStatus = Number((e as { status?: number; response?: { status?: number } }).status
      || (e as { status?: number; response?: { status?: number } }).response?.status
      || 0);
    logger.error('Erro fatal no processarLote', { error: (e as Error).message, status: errStatus, phone, reqId });

    // Mensagem diferenciada por tipo de erro — paciente sabe se vale tentar logo,
    // esperar um pouco, ou se é problema do nosso lado.
    let userMsg = 'Desculpa, tive um probleminha aqui. Pode tentar de novo em alguns segundos?';
    if (errStatus === 429 || errMsg.includes('rate limit') || errMsg.includes('too many requests')) {
      userMsg = 'Tô recebendo muita mensagem agora! Espera uns 30 segundos e tenta de novo, por favor 🙏';
    } else if (errStatus === 401 || errStatus === 403) {
      userMsg = 'Tô com um probleminha de configuração aqui. Já avisei o pessoal! Tenta em alguns minutos.';
    } else if (errStatus === 529 || errMsg.includes('overloaded')) {
      userMsg = 'Tô meio sobrecarregada agora! Pode tentar de novo em 1 minutinho?';
    } else if (errStatus >= 500 && errStatus < 600) {
      userMsg = 'Tô com um problema temporário do meu lado. Tenta de novo em 1 minutinho?';
    } else if (errMsg.includes('circuit')) {
      userMsg = 'Tô meio sobrecarregada agora! Tenta de novo em 1 minutinho, por favor.';
    } else if (errMsg.includes('anthropic') || errMsg.includes('claude')) {
      userMsg = 'Tô pensando um pouco devagar agora... tenta de novo em alguns segundos?';
    } else if (errMsg.includes('supabase') || errMsg.includes('database') || errMsg.includes('pgrst') || errMsg.includes('postgres')) {
      userMsg = 'Tô com um probleminha no sistema. Tenta de novo em 1 minutinho?';
    } else if (errMsg.includes('timeout') || errMsg.includes('etimedout') || errMsg.includes('aborted')) {
      userMsg = 'Demorei demais pra responder, me manda de novo?';
    }
    try {
      await enviarMensagem(phone, userMsg, instanceName);
    } catch {}
  } finally {
    activeBatches--;
  }
}

async function processarLoteInner(phone: string, texts: string[], instanceName: string, pushName: string = '', reqId: string = '') {
  let texto = texts.length === 1 ? texts[0] : texts.join('\n');

  logger.info('Batch iniciado', { phone, msgCount: texts.length, reqId });

  // ── Emergency detection: skip AI, escalate immediately ──
  if (detectEmergency(texto)) {
    logger.warn('EMERGÊNCIA DETECTADA', { phone, reqId, stage: 'emergency' });
    // Load clinic just to mark handoff
    const { data: cl } = await supabase.from('clinicas').select('id, nome').eq('phone_number_id', instanceName).eq('ativa', true).single();
    if (cl) {
      try { await marcarHandoff(cl.id, phone); } catch {}
      notifyDashboard('emergency', cl.id, phone, { keyword: texto.substring(0, 100) });
    }
    await enviarMensagem(phone, EMERGENCY_RESPONSE, instanceName);
    return;
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
    logger.warn('Webhook sem clínica correspondente', { instance: instanceName, reqId });
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
      logger.info('Conversa em handoff, ignorando bot', { phone, reqId, stage: salva.etapa });
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
        // Limpa dados de booking pra evitar que "sim" do paciente confirme um agendamento
        // velho (profissional/data/horário stale). Mantém só identidade (pacienteNome).
        const savedName = ctx.dadosColetados.pacienteNome;
        ctx.dadosColetados = savedName ? { pacienteNome: savedName } : {};
        staleNote = `ATENÇÃO: O paciente voltou após ${hoursAgo}h sem responder. Cumprimente novamente, pergunte como pode ajudar, e NÃO assuma dados de conversas anteriores — colete profissional, data e horário do zero antes de confirmar qualquer coisa.`;
        logger.info('Conversa retomada após gap, dadosColetados limpos', { phone, hoursAgo, reqId, stage: salva.etapa });
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

  // ── Build additional context (stale note, pushName, returning patient) for system prompt ──
  let histFinal = hist || '';
  if (staleNote) {
    histFinal = staleNote + (histFinal ? '\n\n' + histFinal : '');
  }
  if (pushName && !ctx.dadosColetados.pacienteNome) {
    histFinal = (histFinal ? histFinal + '\n\n' : '') +
      'Nome no perfil do WhatsApp deste paciente: ' + pushName +
      '. Ao pedir o nome completo, sugira: "Seu nome é ' + pushName + '?" — se confirmar, use sem pedir de novo.';
  }
  // Returning patient: suggest last professional if no new one has been chosen
  if (antigos.length > 0 && !ctx.dadosColetados.profissional) {
    const lastConfirmed = antigos.find((a: any) => a.status === 'confirmado' || a.status === 'concluido' || a.status === 'cancelado');
    const lastProf = lastConfirmed ? (lastConfirmed.profissionais as any)?.nome : null;
    if (lastProf) {
      histFinal = (histFinal ? histFinal + '\n\n' : '') +
        'PACIENTE RETORNANDO: A última consulta desse paciente foi com ' + lastProf + '. Se ele quiser agendar sem especificar profissional, pergunte "Quer agendar com ' + lastProf + ' de novo?" como primeira sugestão.';
    }
  }

  // ── Process with AI ──
  const resultado = await processarMensagem(texto, ctx, histFinal || undefined);

  // Guard: if AI returned empty response, use fallback to avoid sending empty message
  if (!resultado.resposta || resultado.resposta.trim().length === 0) {
    logger.warn('Resposta vazia do AI, usando fallback', { phone, reqId, stage: resultado.contexto.etapa });
    resultado.resposta = 'Desculpa, tive um probleminha aqui. Pode repetir?';
  }

  // If AI confirmed an appointment, refine prof name from response + detect ambiguity
  if (resultado.contexto.etapa === 'agendamento_concluido') {
    const respNormalized = resultado.resposta.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Conta quantos profissionais aparecem no texto da resposta. Se único, refina o
    // dadosColetados.profissional pro nome canônico. Se múltiplos, NÃO sobrescreve
    // (deixa o check de ambiguidade abaixo decidir com base no que veio da extração).
    const profsInText = clinica.profissionais.filter(p => {
      const np = p.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (respNormalized.includes(np)) return true;
      const words = np.replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/, '').split(/\s+/).filter(w => w.length > 2);
      return words.length > 0 && words.some(w => respNormalized.includes(w));
    });
    if (profsInText.length === 1) {
      resultado.contexto.dadosColetados.profissional = profsInText[0].nome;
    }

    // Valida ambiguidade no profissional final
    // (evita pegar "Dr. João Silva" quando paciente disse só "João" e existe "Dr. João Pereira")
    const profMatch = matchProfissional(
      String(resultado.contexto.dadosColetados.profissional || ''),
      clinica.profissionais
    );
    if (profMatch.ambiguous) {
      const lista = formatProfList(profMatch.candidates);
      logger.warn('Profissional ambíguo, pedindo desambiguação', {
        candidatos: profMatch.candidates.map(p => p.nome).join(', '),
        query: String(resultado.contexto.dadosColetados.profissional || ''),
        phone, reqId, stage: 'ambiguous_prof',
      });
      // Sobrescreve a resposta do AI (que pode ter dito "agendado!") + reseta etapa
      // pra paciente continuar o fluxo de booking sem profissional definido.
      resultado.resposta = `Espera só um instante! Tem mais de um profissional aqui com esse nome: ${lista}. Com qual você quer marcar?`;
      resultado.contexto.etapa = 'inicio';
      delete (resultado.contexto.dadosColetados as Record<string, unknown>).profissional;
    }
  }

  // ── Handle special states AFTER AI response ──

  // CANCELAMENTO: only execute AFTER AI confirms
  if (resultado.contexto.dadosColetados.intencao === 'cancelar' &&
      (resultado.resposta.toLowerCase().includes('cancelad') || resultado.resposta.toLowerCase().includes('desmarcad'))) {
    const futuros = await listarAgendamentosFuturos(clinica.id, phone);

    if (futuros.length === 0) {
      // Nada a cancelar — bot já disse algo. Segue.
      logger.info('Cancelamento solicitado sem agendamentos futuros', { phone, reqId, stage: 'cancel_vazio' });
      await enviarMensagem(phone, resultado.resposta, instanceName);
      await limparConversa(clinica.id, phone);
      return;
    }

    if (futuros.length === 1) {
      // Caso simples — cancela direto
      await cancelarAgendamentoPorId(futuros[0].id);
      logger.info('Agendamento cancelado via bot', { phone, clinica: clinica.nome, agendamentoId: futuros[0].id, reqId, stage: 'cancelado' });
      await enviarMensagem(phone, resultado.resposta, instanceName);
      await limparConversa(clinica.id, phone);
      return;
    }

    // >1 agendamentos: tenta identificar qual via dados extraídos
    const d = resultado.contexto.dadosColetados;
    const match = matchAgendamento(
      { data: d.data, horario: d.horario, profissional: d.profissional },
      futuros
    );

    if (match.matched) {
      await cancelarAgendamentoPorId(match.matched.id);
      logger.info('Agendamento específico cancelado', { phone, agendamentoId: match.matched.id, dt: match.matched.data_hora, reqId, stage: 'cancelado_especifico' });
      await enviarMensagem(phone, resultado.resposta, instanceName);
      await limparConversa(clinica.id, phone);
      return;
    }

    // Ambíguo: lista as opções e pede escolha. Sobrescreve a resposta do AI
    // (que pode ter dito "cancelado!") + mantém intencao=cancelar pra próxima
    // msg do paciente ser interpretada como escolha.
    const lista = futuros.map((a, i) => {
      const dt = new Date(a.data_hora);
      const dataStr = dt.toLocaleDateString('pt-BR');
      const horaStr = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return `${i + 1}. ${dataStr} às ${horaStr} com ${a.profissional_nome}`;
    }).join('\n');
    const msgLista = `Você tem ${futuros.length} consultas marcadas:\n\n${lista}\n\nQual você quer cancelar? Pode me dizer o dia, horário ou profissional.`;

    logger.info('Cancelamento ambíguo, pedindo escolha', { phone, count: futuros.length, reqId, stage: 'cancel_ambiguo' });
    await enviarMensagem(phone, msgLista, instanceName);
    await salvarConversa(clinica.id, phone, {
      etapa: 'cancelamento_solicitado',
      dadosColetados: { ...resultado.contexto.dadosColetados, intencao: 'cancelar' } as Record<string, unknown>,
      historicoMensagens: [
        ...resultado.contexto.historicoMensagens,
        { role: 'assistant', content: msgLista },
      ].slice(-30),
    });
    return;
  }

  // REMARCAÇÃO: cancel existing appointment, continue with new booking flow
  if (resultado.contexto.dadosColetados.intencao === 'remarcar') {
    const cancelled = await cancelarAgendamentoPaciente(clinica.id, phone);
    if (cancelled) {
      logger.info('Agendamento anterior cancelado para remarcação', { phone, clinica: clinica.nome, reqId, stage: 'remarcacao' });
    }
  }

  // HANDOFF: mark for human and stop bot
  if (resultado.contexto.etapa === 'handoff_humano') {
    await marcarHandoff(clinica.id, phone);
    notifyDashboard('handoff', clinica.id, phone);
    logger.info('Handoff para humano', { phone, clinica: clinica.nome, reqId, stage: 'handoff' });
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
      logger.info('AGENDAMENTO INICIANDO', { profissional: String(d.profissional || ''), data: String(d.data || ''), horario: String(d.horario || ''), paciente: String(d.pacienteNome || ''), profsDB: clinica.profissionais.map(p => p.nome).join(', '), reqId, stage: 'agendamento_concluido' });

      const profMatch = matchProfissional(String(d.profissional || ''), clinica.profissionais);
      let prof = profMatch.matched;
      // Fallback: if only 1 professional exists, use them
      if (!prof && !profMatch.ambiguous && clinica.profissionais.length === 1) prof = clinica.profissionais[0];

      const serv = clinica.servicos.find(s => (d.servico || '').toLowerCase().includes(s.nome.toLowerCase()));
      const duracao = serv ? serv.duracaoMinutos : (clinica.servicos[0]?.duracaoMinutos || 30);
      const dt = resolverDataHora(d.data, d.horario);

      logger.info('AGENDAMENTO RESOLVE', { dt: String(dt || 'NULL'), profFound: !!prof, profNome: String(prof?.nome || 'NONE'), reqId });

      if (dt && prof) {
        // Validação final: dia de atendimento, horário func, almoço, passado.
        // Defesa contra AI confirmar agendamento inválido (ex: paciente insiste
        // em domingo mesmo o bot tendo dito que clínica fecha).
        const validacao = validarSlot(dt, clinica, clinicaRow);
        if (!validacao.valido) {
          logger.warn('Slot inválido detectado antes de criar', { motivo: validacao.motivo, dt, phone, reqId, stage: 'slot_invalido' });
          await enviarMensagem(phone, `Ops, esse horário não vai dar — ${validacao.motivo}. Pode escolher outro?`, instanceName);
          // Reset etapa e limpa data/horario pra paciente continuar fluxo
          await salvarConversa(clinica.id, phone, {
            etapa: 'inicio',
            dadosColetados: (() => {
              const novo = { ...resultado.contexto.dadosColetados };
              delete (novo as Record<string, unknown>).data;
              delete (novo as Record<string, unknown>).horario;
              delete (novo as Record<string, unknown>).periodo;
              return novo as Record<string, unknown>;
            })(),
            historicoMensagens: resultado.contexto.historicoMensagens.slice(-30),
          });
          return;
        }

        try {
          await criarAgendamento({ clinicaId: clinica.id, profissionalId: prof.id, pacienteNome: d.pacienteNome || pushName || 'Paciente', pacienteTelefone: phone, dataHora: dt, duracaoMinutos: duracao });
          await limparConversa(clinica.id, phone);
          logger.info('Agendamento salvo', { clinica: clinica.nome, prof: prof.nome, dt, reqId, stage: 'saved' });
          // Friendly follow-up message to close the interaction
          await enviarMensagem(phone, 'Precisa de mais alguma coisa? 😊', instanceName);
        } catch (err) {
          // Slot conflict or other DB error — notify patient so they know
          logger.warn('Conflito ao criar agendamento', { error: (err as Error).message, phone, dt, reqId });
          await enviarMensagem(phone, 'Ops, esse horário acabou de ser preenchido por outro paciente! Pode escolher outro horário?', instanceName);
        }
      } else {
        // Invalid prof/date — don't leave patient thinking they're booked
        logger.warn('AGENDAMENTO FALHOU', { dtNull: !dt, profNull: !prof, data: String(d.data || ''), horario: String(d.horario || ''), profissional: String(d.profissional || ''), reqId });
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

/**
 * Tenta identificar qual agendamento o paciente quer cancelar com base nos
 * dados extraídos (data, horário, profissional). Retorna ambiguous=true se
 * múltiplos batem ou nenhum critério foi informado.
 */
function matchAgendamento(
  d: { data?: string; horario?: string; profissional?: string },
  futuros: AgendamentoFuturo[]
): { matched: AgendamentoFuturo | null; ambiguous: boolean; candidates: AgendamentoFuturo[] } {
  if (futuros.length === 0) return { matched: null, ambiguous: false, candidates: [] };

  let candidatos = [...futuros];

  // Filtro por data
  if (d.data) {
    const dtIso = resolverDataHora(d.data, undefined);
    if (dtIso) {
      const dataAlvo = dtIso.substring(0, 10);
      candidatos = candidatos.filter(a => a.data_hora.substring(0, 10) === dataAlvo);
    }
  }

  // Filtro por hora (se restou >1 e tem horário)
  if (d.horario && candidatos.length > 1) {
    const horaAlvo = String(d.horario).substring(0, 5);
    candidatos = candidatos.filter(a => a.data_hora.substring(11, 16) === horaAlvo);
  }

  // Filtro por profissional (se restou >1 e tem nome)
  if (d.profissional && candidatos.length > 1) {
    const q = String(d.profissional).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/i, '').trim();
    if (q) {
      candidatos = candidatos.filter(a => {
        const np = a.profissional_nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/i, '').trim();
        return np.includes(q) || q.includes(np);
      });
    }
  }

  if (candidatos.length === 1) return { matched: candidatos[0], ambiguous: false, candidates: candidatos };
  if (candidatos.length === 0) return { matched: null, ambiguous: false, candidates: [] };
  return { matched: null, ambiguous: true, candidates: candidatos };
}

/**
 * Validação final antes de criar agendamento. Detecta slots inválidos que o AI
 * pode ter aceitado (paciente insistiu em domingo, fora horário, almoço, passado).
 * Mensagem retornada é amigável e termina sem ponto pra interpolação.
 */
function validarSlot(
  dtIso: string,
  clinica: Clinica,
  clinicaRow: { almoco_inicio?: string; almoco_fim?: string; horario_abertura?: string; horario_fechamento?: string }
): { valido: boolean; motivo?: string } {
  const date = new Date(dtIso);
  if (isNaN(date.getTime())) return { valido: false, motivo: 'data/horário inválidos' };

  // No passado (5min de tolerância)
  if (date.getTime() < Date.now() - 5 * 60000) {
    return { valido: false, motivo: 'esse horário já passou' };
  }

  // Dia de atendimento — ATENÇÃO: getDay() usa timezone local do servidor.
  // O dtIso vem com offset -03:00, então new Date(...) ainda dá UTC. Pra extrair
  // o dia da semana no fuso de Brasília, derivar do próprio ISO.
  const isoMatch = dtIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!isoMatch) return { valido: false, motivo: 'formato de data inválido' };
  const [, yy, mm, dd, hh, mn] = isoMatch;
  const localDate = new Date(+yy, +mm - 1, +dd);
  const dow = localDate.getDay();

  const diasAtend = clinica.diasAtendimento || [1, 2, 3, 4, 5];
  if (!diasAtend.includes(dow)) {
    const nomes = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    return { valido: false, motivo: `não atendemos ${nomes[dow]}` };
  }

  // Horário de funcionamento
  const horaTotal = +hh * 60 + +mn;
  const [abH, abM] = (clinicaRow.horario_abertura || '08:00').split(':').map(Number);
  const [feH, feM] = (clinicaRow.horario_fechamento || '18:00').split(':').map(Number);
  const ab = abH * 60 + abM;
  const fe = feH * 60 + feM;
  if (horaTotal < ab) return { valido: false, motivo: `só abrimos às ${clinicaRow.horario_abertura || '08:00'}` };
  if (horaTotal >= fe) return { valido: false, motivo: `fechamos às ${clinicaRow.horario_fechamento || '18:00'}` };

  // Almoço
  if (clinicaRow.almoco_inicio && clinicaRow.almoco_fim) {
    const [alH, alM] = clinicaRow.almoco_inicio.split(':').map(Number);
    const [afH, afM] = clinicaRow.almoco_fim.split(':').map(Number);
    const al = alH * 60 + alM;
    const af = afH * 60 + afM;
    if (horaTotal >= al && horaTotal < af) {
      return { valido: false, motivo: `é nosso intervalo de almoço (${clinicaRow.almoco_inicio} às ${clinicaRow.almoco_fim})` };
    }
  }

  return { valido: true };
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
  const parsed = parseHorario(horario);
  const h = parsed?.h ?? '09';
  const mn = parsed?.m ?? '00';
  return `${alvo.getFullYear()}-${String(alvo.getMonth() + 1).padStart(2, '0')}-${String(alvo.getDate()).padStart(2, '0')}T${h}:${mn}:00-03:00`;
}

export default router;
