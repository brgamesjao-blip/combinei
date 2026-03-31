import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { buildSystemPrompt, buildExtractionPrompt } from './prompts';
import {
  Clinica,
  ContextoConversa,
  DadosExtraidos,
  Mensagem,
  HorarioDisponivel,
} from '../types';

// ═══════════════════════════════════════
// Motor de IA — Conversa com Claude
// ═══════════════════════════════════════

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Processa uma mensagem do paciente e retorna a resposta do bot.
 * Esta é a função principal — recebe o contexto da conversa e a mensagem,
 * e retorna a resposta + contexto atualizado.
 */
export async function processarMensagem(
  mensagemPaciente: string,
  contexto: ContextoConversa
): Promise<{ resposta: string; contexto: ContextoConversa }> {

  // 1. Extrair dados estruturados da mensagem
  const dadosExtraidos = await extrairDados(mensagemPaciente);
  
  // 2. Atualizar contexto com novos dados
  const contextoAtualizado = atualizarContexto(contexto, dadosExtraidos);

  // 3. Montar horários disponíveis como texto
  const horariosTexto = formatarHorariosDisponiveis(
    contextoAtualizado.horariosOferecidos || []
  );

  // 4. Gerar resposta conversacional com Claude
  const systemPrompt = buildSystemPrompt(contexto.clinica, horariosTexto);

  // Adicionar mensagem do paciente ao histórico
  contextoAtualizado.historicoMensagens.push({
    role: 'user',
    content: mensagemPaciente,
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: contextoAtualizado.historicoMensagens.map(m => ({
      role: m.role,
      content: m.content,
    })),
  });

  const resposta = response.content[0].type === 'text'
    ? response.content[0].text
    : '';

  // Adicionar resposta do bot ao histórico
  contextoAtualizado.historicoMensagens.push({
    role: 'assistant',
    content: resposta,
  });

  // 5. Atualizar etapa da conversa
  contextoAtualizado.etapa = determinarEtapa(contextoAtualizado, resposta);

  return { resposta, contexto: contextoAtualizado };
}

/**
 * Extrai dados estruturados (intenção, profissional, data, etc.)
 * de uma mensagem em linguagem natural.
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

    // Limpar possíveis backticks do JSON
    const clean = text.replace(/```json?\n?|\n?```/g, '').trim();
    return JSON.parse(clean) as DadosExtraidos;
  } catch (error) {
    console.error('Erro ao extrair dados:', error);
    return { intencao: 'outro' };
  }
}

/**
 * Atualiza o contexto da conversa com os novos dados extraídos.
 * Mantém dados anteriores se os novos forem null.
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
    },
  };
}

/**
 * Determina em qual etapa da conversa estamos baseado nos dados coletados.
 */
function determinarEtapa(
  contexto: ContextoConversa,
  resposta: string
): ContextoConversa['etapa'] {
  const { dadosColetados } = contexto;

  // Se a resposta contém "Combinei!" → agendamento concluído
  if (resposta.toLowerCase().includes('combinei!')) {
    return 'agendamento_concluido';
  }

  // Se a intenção é dúvida ou outro → encaminhar
  if (dadosColetados.intencao === 'duvida') {
    return 'encaminhar_humano';
  }

  // Se é agendamento, verificar o que falta
  if (dadosColetados.intencao === 'agendar' || dadosColetados.intencao === 'consultar_horarios') {
    if (!dadosColetados.profissional) return 'coletar_profissional';
    if (!dadosColetados.data) return 'coletar_data';
    if (!dadosColetados.horario) return 'coletar_horario';
    return 'confirmar_agendamento';
  }

  return 'identificar_intencao';
}

/**
 * Formata os horários disponíveis em texto legível para o prompt.
 */
function formatarHorariosDisponiveis(horarios: HorarioDisponivel[]): string {
  if (horarios.length === 0) {
    return 'Nenhum horário disponível carregado ainda.';
  }

  return horarios
    .map(h => `${h.diaSemana} ${h.data}: ${h.horarios.join(', ')}`)
    .join('\n');
}

/**
 * Cria um contexto inicial para uma nova conversa.
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
