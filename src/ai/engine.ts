import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { buildSystemPrompt, buildExtractionPrompt } from './prompts';
import {
  Clinica,
  ContextoConversa,
  DadosExtraidos,
  HorarioDisponivel,
} from '../types';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export async function processarMensagem(
  mensagemPaciente: string,
  contexto: ContextoConversa,
  historicoPaciente?: string
): Promise<{ resposta: string; contexto: ContextoConversa }> {

  const dadosExtraidos = await extrairDados(mensagemPaciente);
  const contextoAtualizado = atualizarContexto(contexto, dadosExtraidos);

  const horariosTexto = formatarHorariosDisponiveis(
    contextoAtualizado.horariosOferecidos || []
  );

  const systemPrompt = buildSystemPrompt(
    contexto.clinica,
    horariosTexto,
    historicoPaciente
  );

  contextoAtualizado.historicoMensagens.push({
    role: 'user',
    content: mensagemPaciente,
  });

  const mensagensRecentes = contextoAtualizado.historicoMensagens.slice(-20);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: mensagensRecentes.map(m => ({
      role: m.role,
      content: m.content,
    })),
  });

  const resposta = response.content[0].type === 'text'
    ? response.content[0].text
    : '';

  contextoAtualizado.historicoMensagens.push({
    role: 'assistant',
    content: resposta,
  });

  contextoAtualizado.etapa = determinarEtapa(contextoAtualizado, dadosExtraidos, resposta);

  return { resposta, contexto: contextoAtualizado };
}

export async function extrairDados(mensagem: string): Promise<DadosExtraidos> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: buildExtractionPrompt(),
      messages: [{ role: 'user', content: mensagem }],
    });

    const text = response.content[0].type === 'text'
      ? response.content[0].text
      : '{}';

    const clean = text.replace(/```json?\n?|\n?```/g, '').trim();
    return JSON.parse(clean) as DadosExtraidos;
  } catch (error) {
    console.error('Erro ao extrair dados:', error);
    return { intencao: 'outro' };
  }
}

function atualizarContexto(
  contexto: ContextoConversa,
  dados: DadosExtraidos
): ContextoConversa {
  return {
    ...contexto,
    dadosColetados: {
      ...contexto.dadosColetados,
      intencao: dados.intencao || contexto.dadosColetados.intencao,
      profissional: dados.profissional || contexto.dadosColetados.profissional,
      servico: dados.servico || contexto.dadosColetados.servico,
      data: dados.data || contexto.dadosColetados.data,
      horario: dados.horario || contexto.dadosColetados.horario,
      periodo: dados.periodo || contexto.dadosColetados.periodo,
      pacienteNome: dados.pacienteNome || contexto.dadosColetados.pacienteNome,
    },
  };
}

function determinarEtapa(
  contexto: ContextoConversa,
  dados: DadosExtraidos,
  resposta: string
): ContextoConversa['etapa'] {
  if (resposta.toLowerCase().includes('combinei!')) {
    return 'agendamento_concluido';
  }

  const intencao = String(dados.intencao);

  if (intencao === 'cancelar') return 'identificar_intencao';
  if (intencao === 'duvida') return 'encaminhar_humano';
  if (intencao === 'saudacao' || intencao === 'agradecimento') return 'inicio';

  if (intencao === 'agendar' || intencao === 'remarcar' || intencao === 'consultar_horarios') {
    const d = contexto.dadosColetados;
    if (!d.profissional) return 'coletar_profissional';
    if (!d.data) return 'coletar_data';
    if (!d.horario) return 'coletar_horario';
    return 'confirmar_agendamento';
  }

  return 'identificar_intencao';
}

function formatarHorariosDisponiveis(horarios: HorarioDisponivel[]): string {
  if (horarios.length === 0) return '';

  return horarios
    .map(h => `${h.diaSemana} ${h.data}: ${h.horarios.join(', ')}`)
    .join('\n');
}

export function criarContextoInicial(clinica: Clinica): ContextoConversa {
  return {
    clinica,
    etapa: 'inicio',
    dadosColetados: {},
    horariosOferecidos: [],
    historicoMensagens: [],
  };
}
