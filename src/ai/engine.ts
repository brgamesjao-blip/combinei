import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { buildSystemPrompt, buildExtractionPrompt } from './prompts';
import {
  Clinica,
  ContextoConversa,
  DadosExtraidos,
  HorarioDisponivel,
} from '../types';

// ═══════════════════════════════════════
// Motor de IA — Conversa Inteligente
// ═══════════════════════════════════════

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Processa uma mensagem e retorna resposta + contexto atualizado.
 */
export async function processarMensagem(
  mensagemPaciente: string,
  contexto: ContextoConversa,
  historicoPaciente?: string
): Promise<{ resposta: string; contexto: ContextoConversa }> {

  // 1. Extrair dados
  const dadosExtraidos = await extrairDados(mensagemPaciente);

  // 2. Atualizar contexto
  const contextoAtualizado = atualizarContexto(contexto, dadosExtraidos);

  // 3. Horários como texto
  const horariosTexto = formatarHorariosDisponiveis(
    contextoAtualizado.horariosOferecidos || []
  );

  // 4. Gerar resposta com Claude
  const systemPrompt = buildSystemPrompt(
    contexto.clinica,
    horariosTexto,
    historicoPaciente
  );

  contextoAtualizado.historicoMensagens.push({
    role: 'user',
    content: mensagemPaciente,
  });

  // Limitar histórico pra não estourar contexto (últimas 20 mensagens)
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

  // 5. Atualizar etapa
  contextoAtualizado.etapa = determinarEtapa(contextoAtualizado, dadosExtraidos, resposta);

  return { resposta, contexto: contextoAtualizado };
}

/**
 * Extrai dados estruturados da mensagem.
 */
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

/**
 * Atualiza contexto com novos dados extraídos.
 */
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

/**
 * Determina etapa da conversa.
 */
function determinarEtapa(
  contexto: ContextoConversa,
  dados: DadosExtraidos,
  resposta: string
): ContextoConversa['etapa'] {
  // Combinei! = agendamento concluído
  if (resposta.toLowerCase().includes('combinei!')) {
    return 'agendamento_concluido';
  }

  // Cancelamento
  if (dados.intencao === 'cancelar') {
    return 'identificar_intencao';
  }

  // Dúvida → encaminhar humano
  if (dados.intencao === 'duvida') {
    return 'encaminhar_humano';
  }

  // Saudação ou agradecimento
  if (dados.intencao === 'saudacao' || dados.intencao === 'agradecimento') {
    return 'inicio';
  }

  // Agendamento
  if (dados.intencao === 'agendar' || dados.intencao === 'remarcar' || dados.intencao === 'consultar_horarios') {
    const d = contexto.dadosColetados;
    if (!d.profissional) return 'coletar_profissional';
    if (!d.data) return 'coletar_data';
    if (!d.horario) return 'coletar_horario';
    return 'confirmar_agendamento';
  }

  return 'identificar_intencao';
}

/**
 * Formata horários disponíveis.
 */
function formatarHorariosDisponiveis(horarios: HorarioDisponivel[]): string {
  if (horarios.length === 0) return '';

  return horarios
    .map(h => `${h.diaSemana} ${h.data}: ${h.horarios.join(', ')}`)
    .join('\n');
}

/**
 * Cria contexto inicial.
 */
export function criarContextoInicial(clinica: Clinica): ContextoConversa {
  return {
    clinica,
    etapa: 'inicio',
    dadosColetados: {},
    horariosOferecidos: [],
    historicoMensagens: [],
  };
}
