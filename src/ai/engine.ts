import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { buildSystemPrompt, buildExtractionPrompt } from './prompts';
import { Clinica, ContextoConversa, DadosExtraidos, HorarioDisponivel } from '../types';
import { logger } from '../utils/logger';
import { withCircuitBreaker } from '../utils/circuitBreaker';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const FALLBACK_MSG = 'Desculpa, estou com um probleminha técnico. Pode tentar de novo em alguns minutos?';

export async function processarMensagem(
  msg: string, contexto: ContextoConversa, historico?: string
): Promise<{ resposta: string; contexto: ContextoConversa }> {
  const dados = await extrairDados(msg);
  const ctx: ContextoConversa = {
    ...contexto,
    dadosColetados: { ...contexto.dadosColetados },
    historicoMensagens: [...contexto.historicoMensagens],
  };

  if (dados.intencao) ctx.dadosColetados.intencao = dados.intencao;
  if (dados.profissional) ctx.dadosColetados.profissional = dados.profissional;
  if (dados.data) ctx.dadosColetados.data = dados.data;
  if (dados.horario) ctx.dadosColetados.horario = dados.horario;
  if (dados.periodo) ctx.dadosColetados.periodo = dados.periodo;
  if (dados.pacienteNome) ctx.dadosColetados.pacienteNome = dados.pacienteNome;

  // Detect handoff intent BEFORE calling AI
  if (dados.intencao === 'falar_humano') {
    ctx.etapa = 'handoff_humano';
  }

  // Detect cancel intent
  if (dados.intencao === 'cancelar') {
    ctx.etapa = 'cancelamento_solicitado';
  }

  const horariosTexto = (ctx.horariosOferecidos || [])
    .map((h: HorarioDisponivel) => `${h.diaSemana} ${h.data}: ${h.horarios.join(', ')}`)
    .join('\n');

  ctx.historicoMensagens.push({ role: 'user', content: msg });

  // Circuit breaker around Anthropic API
  const resposta = await withCircuitBreaker<string>('anthropic-chat', async () => {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: buildSystemPrompt(contexto.clinica, horariosTexto, historico),
      messages: ctx.historicoMensagens.slice(-20).map(m => ({
        role: m.role as 'user' | 'assistant', content: m.content,
      })),
    });
    return response.content[0].type === 'text' ? response.content[0].text : '';
  }, FALLBACK_MSG);

  ctx.historicoMensagens.push({ role: 'assistant', content: resposta });

  // Detect conclusion from AI response
  if (resposta.toLowerCase().includes('combinei!')) {
    ctx.etapa = 'agendamento_concluido';
    const timeMatch = resposta.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) ctx.dadosColetados.horario = timeMatch[1].padStart(2, '0') + ':' + timeMatch[2];
    const dateMatch = resposta.match(/(\d{2})\/(\d{2})/);
    if (dateMatch) ctx.dadosColetados.data = `${new Date().getFullYear()}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
  }

  return { resposta, contexto: ctx };
}

/** Uses Haiku (cheaper/faster) for structured data extraction */
async function extrairDados(msg: string): Promise<DadosExtraidos> {
  try {
    const r = await withCircuitBreaker('anthropic-extract', async () => {
      return anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',  // Haiku = 10x cheaper for extraction
        max_tokens: 300,
        system: buildExtractionPrompt(),
        messages: [{ role: 'user', content: msg }],
      });
    });
    if (!r) return { intencao: 'outro' };
    const t = r.content[0].type === 'text' ? r.content[0].text : '{}';
    return JSON.parse(t.replace(/```json?\n?|\n?```/g, '').trim());
  } catch (e) {
    logger.warn('Falha extração', { error: (e as Error).message });
    return { intencao: 'outro' };
  }
}

export function criarContextoInicial(clinica: Clinica): ContextoConversa {
  return { clinica, etapa: 'inicio', dadosColetados: {}, horariosOferecidos: [], historicoMensagens: [] };
}

