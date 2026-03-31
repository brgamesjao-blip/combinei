import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { buildSystemPrompt, buildExtractionPrompt } from './prompts';
import { Clinica, ContextoConversa, DadosExtraidos, HorarioDisponivel } from '../types';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export async function processarMensagem(
  msg: string, contexto: ContextoConversa, historico?: string
): Promise<{ resposta: string; contexto: ContextoConversa }> {
  const dados = await extrairDados(msg);
  const ctx = { ...contexto, dadosColetados: { ...contexto.dadosColetados } };

  if (dados.intencao) ctx.dadosColetados.intencao = dados.intencao;
  if (dados.profissional) ctx.dadosColetados.profissional = dados.profissional;
  if (dados.data) ctx.dadosColetados.data = dados.data;
  if (dados.horario) ctx.dadosColetados.horario = dados.horario;
  if (dados.periodo) ctx.dadosColetados.periodo = dados.periodo;
  if (dados.pacienteNome) ctx.dadosColetados.pacienteNome = dados.pacienteNome;

  const horariosTexto = (ctx.horariosOferecidos || [])
    .map(h => `${h.diaSemana} ${h.data}: ${h.horarios.join(', ')}`).join('\n');

  ctx.historicoMensagens.push({ role: 'user', content: msg });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: buildSystemPrompt(contexto.clinica, horariosTexto, historico),
    messages: ctx.historicoMensagens.slice(-20).map(m => ({ role: m.role as any, content: m.content })),
  });

  const resposta = response.content[0].type === 'text' ? response.content[0].text : '';
  ctx.historicoMensagens.push({ role: 'assistant', content: resposta });

  if (resposta.toLowerCase().includes('combinei!')) ctx.etapa = 'agendamento_concluido';

  return { resposta, contexto: ctx };
}

async function extrairDados(msg: string): Promise<DadosExtraidos> {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: buildExtractionPrompt(),
      messages: [{ role: 'user', content: msg }],
    });
    const t = r.content[0].type === 'text' ? r.content[0].text : '{}';
    return JSON.parse(t.replace(/```json?\n?|\n?```/g, '').trim());
  } catch (e) {
    return { intencao: 'outro' };
  }
}

export function criarContextoInicial(clinica: Clinica): ContextoConversa {
  return { clinica, etapa: 'inicio', dadosColetados: {}, horariosOferecidos: [], historicoMensagens: [] };
}
