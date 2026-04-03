import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { buildSystemPrompt, buildExtractionPrompt } from './prompts';
import { Clinica, ContextoConversa, DadosExtraidos, HorarioDisponivel } from '../types';

var anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export async function processarMensagem(
  msg: string, contexto: ContextoConversa, historico?: string
): Promise<{ resposta: string; contexto: ContextoConversa }> {
  var dados = await extrairDados(msg);
  var ctx = { ...contexto, dadosColetados: { ...contexto.dadosColetados } };

  if (dados.intencao) ctx.dadosColetados.intencao = dados.intencao;
  if (dados.profissional) ctx.dadosColetados.profissional = dados.profissional;
  if (dados.data) ctx.dadosColetados.data = dados.data;
  if (dados.horario) ctx.dadosColetados.horario = dados.horario;
  if (dados.periodo) ctx.dadosColetados.periodo = dados.periodo;
  if (dados.pacienteNome) ctx.dadosColetados.pacienteNome = dados.pacienteNome;

  var horariosTexto = (ctx.horariosOferecidos || [])
    .map(function(h: HorarioDisponivel) { return h.diaSemana + ' ' + h.data + ': ' + h.horarios.join(', '); }).join('\n');

  ctx.historicoMensagens.push({ role: 'user', content: msg });

  var response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    system: buildSystemPrompt(contexto.clinica, horariosTexto, historico),
    messages: ctx.historicoMensagens.slice(-20).map(function(m) { return { role: m.role as any, content: m.content }; }),
  });

  var resposta = response.content[0].type === 'text' ? response.content[0].text : '';
  ctx.historicoMensagens.push({ role: 'assistant', content: resposta });

  // Extract confirmed time from the Combinei! message
  if (resposta.toLowerCase().includes('combinei!')) {
    ctx.etapa = 'agendamento_concluido';

    // Try to extract the confirmed time from the AI's own response
    var timeMatch = resposta.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      ctx.dadosColetados.horario = timeMatch[1].padStart(2, '0') + ':' + timeMatch[2];
    }

    // Try to extract date from response (DD/MM format)
    var dateMatch = resposta.match(/(\d{2})\/(\d{2})/);
    if (dateMatch) {
      var year = new Date().getFullYear();
      ctx.dadosColetados.data = year + '-' + dateMatch[2].padStart(2, '0') + '-' + dateMatch[1].padStart(2, '0');
    }
  }

  return { resposta, contexto: ctx };
}

async function extrairDados(msg: string): Promise<DadosExtraidos> {
  try {
    var r = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: buildExtractionPrompt(),
      messages: [{ role: 'user', content: msg }],
    });
    var t = r.content[0].type === 'text' ? r.content[0].text : '{}';
    return JSON.parse(t.replace(/```json?\n?|\n?```/g, '').trim());
  } catch (e) {
    return { intencao: 'outro' };
  }
}

export function criarContextoInicial(clinica: Clinica): ContextoConversa {
  return { clinica, etapa: 'inicio', dadosColetados: {}, horariosOferecidos: [], historicoMensagens: [] };
}
