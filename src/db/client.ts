import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { Clinica, Profissional, Servico, ContextoConversa, Mensagem } from '../types';

// ═══════════════════════════════════════
// Supabase Client — Banco de Dados
// ═══════════════════════════════════════

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

export { supabase };

// ─── Clínicas ───

/**
 * Busca uma clínica pelo phone_number_id do WhatsApp.
 * Chamado quando recebe uma mensagem no webhook.
 */
export async function buscarClinicaPorPhone(phoneNumberId: string): Promise<Clinica | null> {
  const { data: clinica } = await supabase
    .from('clinicas')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .eq('ativa', true)
    .single();

  if (!clinica) return null;

  // Buscar profissionais
  const { data: profissionais } = await supabase
    .from('profissionais')
    .select('*')
    .eq('clinica_id', clinica.id)
    .eq('ativo', true);

  // Buscar serviços
  const { data: servicos } = await supabase
    .from('servicos')
    .select('*')
    .eq('clinica_id', clinica.id)
    .eq('ativo', true);

  return {
    id: clinica.id,
    nome: clinica.nome,
    telefone: clinica.telefone,
    profissionais: (profissionais || []).map(p => ({
      id: p.id,
      nome: p.nome,
      especialidade: p.especialidade,
      servicos: [],
    })),
    servicos: (servicos || []).map(s => ({
      id: s.id,
      nome: s.nome,
      duracaoMinutos: s.duracao_minutos,
      preco: s.preco,
    })),
    horarioFuncionamento: {
      segunda: { inicio: clinica.horario_abertura, fim: clinica.horario_fechamento },
      terca: { inicio: clinica.horario_abertura, fim: clinica.horario_fechamento },
      quarta: { inicio: clinica.horario_abertura, fim: clinica.horario_fechamento },
      quinta: { inicio: clinica.horario_abertura, fim: clinica.horario_fechamento },
      sexta: { inicio: clinica.horario_abertura, fim: clinica.horario_fechamento },
      sabado: null,
      domingo: null,
    },
  };
}

/**
 * Busca uma clínica pelo ID.
 */
export async function buscarClinicaPorId(id: string): Promise<Clinica | null> {
  const { data: clinica } = await supabase
    .from('clinicas')
    .select('*')
    .eq('id', id)
    .single();

  if (!clinica) return null;

  return buscarClinicaPorPhone(clinica.phone_number_id);
}

/**
 * Busca tokens do Google Calendar de uma clínica.
 */
export async function buscarTokensGoogle(clinicaId: string) {
  const { data } = await supabase
    .from('clinicas')
    .select('google_access_token, google_refresh_token, google_calendar_id')
    .eq('id', clinicaId)
    .single();

  if (!data || !data.google_access_token) return null;

  return {
    access_token: data.google_access_token,
    refresh_token: data.google_refresh_token,
    calendar_id: data.google_calendar_id || 'primary',
  };
}

/**
 * Salva tokens do Google Calendar de uma clínica.
 */
export async function salvarTokensGoogle(
  clinicaId: string,
  tokens: { access_token?: string | null; refresh_token?: string | null }
) {
  const update: any = {};
  if (tokens.access_token) update.google_access_token = tokens.access_token;
  if (tokens.refresh_token) update.google_refresh_token = tokens.refresh_token;

  await supabase
    .from('clinicas')
    .update(update)
    .eq('id', clinicaId);
}

// ─── Conversas ───

/**
 * Busca ou cria o contexto de uma conversa.
 */
export async function buscarConversa(
  clinicaId: string,
  pacienteTelefone: string
): Promise<{ etapa: string; dadosColetados: any; historicoMensagens: Mensagem[] } | null> {
  const { data } = await supabase
    .from('conversas')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('paciente_telefone', pacienteTelefone)
    .single();

  if (!data) return null;

  return {
    etapa: data.etapa,
    dadosColetados: data.dados_coletados || {},
    historicoMensagens: data.historico_mensagens || [],
  };
}

/**
 * Salva o contexto de uma conversa.
 */
export async function salvarConversa(
  clinicaId: string,
  pacienteTelefone: string,
  contexto: { etapa: string; dadosColetados: any; historicoMensagens: Mensagem[] }
) {
  await supabase
    .from('conversas')
    .upsert({
      clinica_id: clinicaId,
      paciente_telefone: pacienteTelefone,
      etapa: contexto.etapa,
      dados_coletados: contexto.dadosColetados,
      historico_mensagens: contexto.historicoMensagens,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'clinica_id,paciente_telefone',
    });
}

/**
 * Limpa uma conversa (quando agendamento é concluído).
 */
export async function limparConversa(clinicaId: string, pacienteTelefone: string) {
  await supabase
    .from('conversas')
    .delete()
    .eq('clinica_id', clinicaId)
    .eq('paciente_telefone', pacienteTelefone);
}

// ─── Agendamentos ───

/**
 * Cria um agendamento no banco.
 */
export async function criarAgendamento(agendamento: {
  clinicaId: string;
  profissionalId: string;
  servicoId?: string;
  pacienteNome: string;
  pacienteTelefone: string;
  dataHora: string;
  duracaoMinutos: number;
  googleEventId?: string;
}) {
  const { data, error } = await supabase
    .from('agendamentos')
    .insert({
      clinica_id: agendamento.clinicaId,
      profissional_id: agendamento.profissionalId,
      servico_id: agendamento.servicoId,
      paciente_nome: agendamento.pacienteNome,
      paciente_telefone: agendamento.pacienteTelefone,
      data_hora: agendamento.dataHora,
      duracao_minutos: agendamento.duracaoMinutos,
      google_event_id: agendamento.googleEventId,
      status: 'confirmado',
    })
    .select()
    .single();

  if (error) {
    console.error('Erro ao criar agendamento:', error);
    throw error;
  }

  return data;
}

/**
 * Lista agendamentos de uma clínica.
 */
export async function listarAgendamentos(clinicaId: string, limit: number = 20) {
  const { data } = await supabase
    .from('agendamentos')
    .select('*, profissionais(nome, especialidade), servicos(nome)')
    .eq('clinica_id', clinicaId)
    .eq('status', 'confirmado')
    .gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true })
    .limit(limit);

  return data || [];
}

/**
 * Cancela um agendamento.
 */
export async function cancelarAgendamento(agendamentoId: string) {
  await supabase
    .from('agendamentos')
    .update({ status: 'cancelado' })
    .eq('id', agendamentoId);
}
