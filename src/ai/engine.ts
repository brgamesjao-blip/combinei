import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { buildSystemPrompt, buildExtractionPrompt } from './prompts';
import { Clinica, ContextoConversa, DadosExtraidos, HorarioDisponivel } from '../types';
import { logger } from '../utils/logger';
import { withCircuitBreaker } from '../utils/circuitBreaker';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// Extraction prompt é constante — cacheia uma vez no module load
const EXTRACTION_PROMPT = buildExtractionPrompt();

export async function processarMensagem(
  msg: string, contexto: ContextoConversa, historico?: string
): Promise<{ resposta: string; contexto: ContextoConversa }> {
  // Pass recent conversation history so extraction understands context
  const recentMessages = contexto.historicoMensagens.slice(-6);
  const dados = await extrairDados(msg, recentMessages);
  const ctx: ContextoConversa = {
    ...contexto,
    dadosColetados: { ...contexto.dadosColetados },
    historicoMensagens: [...contexto.historicoMensagens],
  };

  // Preserve more specific intents: don't overwrite "agendar" with "outro"
  if (dados.intencao && (dados.intencao !== 'outro' || !ctx.dadosColetados.intencao)) {
    ctx.dadosColetados.intencao = dados.intencao;
  }
  if (dados.profissional) ctx.dadosColetados.profissional = dados.profissional;
  if (dados.data) ctx.dadosColetados.data = dados.data;
  if (dados.horario) ctx.dadosColetados.horario = dados.horario;
  if (dados.periodo) ctx.dadosColetados.periodo = dados.periodo;
  if (dados.pacienteNome) ctx.dadosColetados.pacienteNome = dados.pacienteNome;

  // Mudança de ideia mid-flow: "muda o profissional", "outro horário", "outro dia"
  // sem trazer um novo valor → limpar o campo pra não confirmar com dado obsoleto.
  aplicarCorrecoes(msg, dados, ctx);

  if (dados.intencao === 'falar_humano') ctx.etapa = 'handoff_humano';
  if (dados.intencao === 'cancelar') ctx.etapa = 'cancelamento_solicitado';

  const horariosTexto = (ctx.horariosOferecidos || [])
    .map((h: HorarioDisponivel) => `${h.diaSemana} ${h.data}: ${h.horarios.join(', ')}`)
    .join('\n');

  ctx.historicoMensagens.push({ role: 'user', content: msg });

  const systemPrompt = buildSystemPrompt(contexto.clinica, horariosTexto, historico);
  const messagesForAI = ctx.historicoMensagens.slice(-20).map(m => ({
    role: m.role as 'user' | 'assistant', content: m.content,
  }));

  // Debug: log AI call details in development
  logger.debug('AI CALL', {
    staticLen: systemPrompt.static.length,
    dynamicLen: systemPrompt.dynamic.length,
    msgCount: messagesForAI.length,
    lastMsg: messagesForAI[messagesForAI.length - 1]?.content?.substring(0, 200),
  });

  // Prompt caching: bloco estático (clínica + regras) é cacheado por 5min.
  // Dinâmico (data/hora, slots, histórico) muda a cada call e fica fora do cache.
  // Sem fallback no circuit breaker: erro propaga pro processarLote que diferencia
  // por tipo (rate limit, auth, 5xx, timeout, etc) e responde mensagem específica.
  const resposta = await withCircuitBreaker<string>('anthropic-chat', async () => {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      temperature: 0.7,
      system: [
        { type: 'text', text: systemPrompt.static, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: systemPrompt.dynamic },
      ],
      messages: messagesForAI,
    });
    return response.content[0].type === 'text' ? response.content[0].text : '';
  });

  logger.debug('AI RESPONSE', { response: resposta.substring(0, 300) });

  ctx.historicoMensagens.push({ role: 'assistant', content: resposta });

  // Detect appointment conclusion - multiple phrases
  // Only trigger if AI confirms AND we have minimum data (profissional + horario or data)
  const rl = resposta.toLowerCase();
  const hasConfirmPhrase = (
    rl.includes('combinei') || rl.includes('agendado') || rl.includes('agendada') ||
    rl.includes('combinado') || rl.includes('marcado') || rl.includes('marcada') ||
    rl.includes('com sucesso') || rl.includes('agendamento confirmado') ||
    rl.includes('consulta confirmada') || rl.includes('está confirmad')
  );
  // Must have profissional AND (date or time extracted from AI response)
  const hasDate = !!resposta.match(/\d{2}\/\d{2}/);
  const hasTime = !!resposta.match(/\d{1,2}:\d{2}/);
  const hasProf = !!(ctx.dadosColetados.profissional);
  const hasMinData = hasProf && (hasDate || hasTime);

  if (hasConfirmPhrase && hasMinData) {
    ctx.etapa = 'agendamento_concluido';
    const timeMatch = resposta.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) ctx.dadosColetados.horario = timeMatch[1].padStart(2, '0') + ':' + timeMatch[2];
    const dateMatch = resposta.match(/(\d{2})\/(\d{2})/);
    const brazilNow = new Date(Date.now() - 3 * 3600000);
    if (dateMatch) {
      const day = parseInt(dateMatch[1]), month = parseInt(dateMatch[2]);
      let year = brazilNow.getFullYear();
      // If the month is in the past (e.g. confirming January in December), use next year
      if (month < brazilNow.getMonth() + 1 || (month === brazilNow.getMonth() + 1 && day < brazilNow.getDate())) {
        year++;
      }
      ctx.dadosColetados.data = `${year}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
    }
    logger.info('Agendamento detectado', { data: String(ctx.dadosColetados.data || ''), horario: String(ctx.dadosColetados.horario || ''), profissional: String(ctx.dadosColetados.profissional || ''), paciente: String(ctx.dadosColetados.pacienteNome || '') });
  }

  return { resposta, contexto: ctx };
}

/**
 * Mascarar valores de campos sensíveis no rawSample antes de logar.
 * Haiku às vezes retorna JSON malformado mas com dados extraídos —
 * pacienteNome ou profissional não devem ir parar em log de erro.
 */
function sanitizeRaw(s: string): string {
  return s
    .replace(/"pacienteNome"\s*:\s*"[^"]*"/g, '"pacienteNome":"***"')
    .replace(/"paciente_nome"\s*:\s*"[^"]*"/g, '"paciente_nome":"***"')
    .replace(/"profissional"\s*:\s*"[^"]*"/g, '"profissional":"***"')
    .substring(0, 150);
}

/**
 * Detecta sinais de correção/mudança na mensagem do paciente sem novo valor.
 * Ex: "muda o profissional" sem dizer qual → deletar dadosColetados.profissional
 * pra forçar o bot a perguntar de novo em vez de confirmar com o velho.
 */
function aplicarCorrecoes(
  msg: string,
  dados: DadosExtraidos,
  ctx: ContextoConversa
): void {
  const m = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const sinalMudanca = /\b(muda|mudar|mudei|trocar|troca|trocou|outro|outra|esquece|esqueci|prefiro|prefere|na verdade|melhor|nao|pera|espera|opa|ai nao|opa nao)\b/.test(m);
  if (!sinalMudanca) return;

  // "muda profissional/médico/doutor" sem trazer novo nome
  if (/\b(profissional|medico|medica|doutor|doutora|dr|dra)\b/.test(m) && !dados.profissional) {
    delete (ctx.dadosColetados as Record<string, unknown>).profissional;
  }
  // "muda dia/data" sem trazer nova
  if (/\b(dia|data)\b/.test(m) && !dados.data) {
    delete (ctx.dadosColetados as Record<string, unknown>).data;
  }
  // "muda hora/horario/horarios" sem trazer novo
  if (/\b(hora|horario|horarios|horas)\b/.test(m) && !dados.horario) {
    delete (ctx.dadosColetados as Record<string, unknown>).horario;
    delete (ctx.dadosColetados as Record<string, unknown>).periodo;
  }
  // "muda servico" sem trazer novo
  if (/\b(servico|exame|consulta|procedimento)\b/.test(m) && !dados.servico) {
    delete (ctx.dadosColetados as Record<string, unknown>).servico;
  }
}

const VALID_INTENCOES: ReadonlyArray<DadosExtraidos['intencao']> = [
  'agendar', 'remarcar', 'cancelar', 'consultar_horarios',
  'saudacao', 'duvida', 'agradecimento', 'falar_humano', 'outro',
];

async function extrairDados(
  msg: string,
  recentMessages?: Array<{ role: string; content: string }>
): Promise<DadosExtraidos> {
  // Skip extraction for pure media markers (confuse the extraction model)
  if (msg.trim().startsWith('[O paciente enviou') && msg.trim().endsWith(']')) {
    return { intencao: 'outro' };
  }
  let rawText = '';
  try {
    // Build user message with conversation context for better understanding
    let userMsg = msg;
    if (recentMessages && recentMessages.length > 0) {
      const ctx = recentMessages.slice(-6).map(m =>
        `${m.role === 'user' ? 'PACIENTE' : 'RECEPCIONISTA'}: ${m.content}`
      ).join('\n');
      userMsg = `CONTEXTO DA CONVERSA:\n${ctx}\n\n---\nMENSAGEM ATUAL (extraia dados desta):\n${msg}`;
    }

    const r = await withCircuitBreaker('anthropic-extract', async () => {
      return anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: [
          { type: 'text', text: EXTRACTION_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: userMsg }],
      });
    });
    if (!r) return { intencao: 'outro' };
    rawText = r.content[0].type === 'text' ? r.content[0].text : '{}';
    const cleaned = rawText.replace(/```json?\n?|\n?```/g, '').trim();

    let parsed: Partial<DadosExtraidos> | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Fallback: extrair primeiro bloco {...} se vier com texto no entorno
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {}
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      logger.warn('Extração JSON inválido', {
        rawSample: sanitizeRaw(rawText),
        msgSample: msg.substring(0, 100),
      });
      return { intencao: 'outro' };
    }

    // Validar intencao — Haiku às vezes inventa valores fora do enum
    const intencao = parsed.intencao as DadosExtraidos['intencao'];
    if (typeof intencao !== 'string' || !VALID_INTENCOES.includes(intencao)) {
      logger.warn('Extração intenção inválida', {
        intencao: String(intencao),
        rawSample: sanitizeRaw(rawText),
      });
      parsed.intencao = 'outro';
    }
    return parsed as DadosExtraidos;
  } catch (e) {
    logger.warn('Falha extração', {
      error: (e as Error).message,
      rawSample: sanitizeRaw(rawText),
      msgSample: msg.substring(0, 100),
    });
    return { intencao: 'outro' };
  }
}

export function criarContextoInicial(clinica: Clinica): ContextoConversa {
  return { clinica, etapa: 'inicio', dadosColetados: {}, horariosOferecidos: [], historicoMensagens: [] };
}
