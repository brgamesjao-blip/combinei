import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

export async function buscarConversa(clinicaId: string, telefone: string) {
  const { data } = await supabase.from('conversas').select('*')
    .eq('clinica_id', clinicaId).eq('paciente_telefone', telefone).single();
  if (!data) return null;
  return { etapa: data.etapa, dadosColetados: data.dados_coletados || {}, historicoMensagens: data.historico_mensagens || [], updatedAt: data.updated_at || null };
}

export async function salvarConversa(clinicaId: string, telefone: string, ctx: {
  etapa: string; dadosColetados: Record<string, unknown>; historicoMensagens: Array<{ role: string; content: string }>;
}) {
  await supabase.from('conversas').upsert({
    clinica_id: clinicaId, paciente_telefone: telefone,
    etapa: ctx.etapa, dados_coletados: ctx.dadosColetados,
    historico_mensagens: ctx.historicoMensagens, updated_at: new Date().toISOString(),
  }, { onConflict: 'clinica_id,paciente_telefone' });
}

export async function limparConversa(clinicaId: string, telefone: string) {
  await supabase.from('conversas').delete().eq('clinica_id', clinicaId).eq('paciente_telefone', telefone);
}

export async function criarAgendamento(a: {
  clinicaId: string; profissionalId: string; pacienteNome: string;
  pacienteTelefone: string; dataHora: string; duracaoMinutos: number;
}) {
  // Idempotency: check duplicate
  const { data: dup } = await supabase.from('agendamentos').select('id')
    .eq('clinica_id', a.clinicaId).eq('paciente_telefone', a.pacienteTelefone)
    .eq('data_hora', a.dataHora).eq('status', 'confirmado').limit(1);
  if (dup && dup.length > 0) return;

  // Pre-check: rápido e dá log claro nos casos não-race.
  const { data: conflict } = await supabase.from('agendamentos').select('id')
    .eq('clinica_id', a.clinicaId).eq('profissional_id', a.profissionalId)
    .eq('data_hora', a.dataHora).eq('status', 'confirmado').limit(1);
  if (conflict && conflict.length > 0) throw new Error('Horário já ocupado para este profissional');

  // Race window entre pre-check e insert é fechada pelo partial unique index
  // idx_agendamentos_unique_slot (migration 002). Postgres retorna code 23505.
  const { error } = await supabase.from('agendamentos').insert({
    clinica_id: a.clinicaId, profissional_id: a.profissionalId,
    paciente_nome: a.pacienteNome.substring(0, 200), paciente_telefone: a.pacienteTelefone,
    data_hora: a.dataHora, duracao_minutos: a.duracaoMinutos, status: 'confirmado',
  });
  if (error) {
    if (error.code === '23505') throw new Error('Horário já ocupado para este profissional');
    throw new Error(`Falha ao inserir agendamento: ${error.message}`);
  }
}

export interface AgendamentoFuturo {
  id: string;
  data_hora: string;
  duracao_minutos: number;
  profissional_nome: string;
}

/** Lista agendamentos futuros confirmados deste paciente, ordenados por data. */
export async function listarAgendamentosFuturos(
  clinicaId: string, telefone: string
): Promise<AgendamentoFuturo[]> {
  const { data } = await supabase.from('agendamentos')
    .select('id, data_hora, duracao_minutos, profissionais(nome)')
    .eq('clinica_id', clinicaId).eq('paciente_telefone', telefone)
    .eq('status', 'confirmado').gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true });
  return (data || []).map((a: { id: string; data_hora: string; duracao_minutos: number; profissionais: { nome: string } | null }) => ({
    id: a.id,
    data_hora: a.data_hora,
    duracao_minutos: a.duracao_minutos,
    profissional_nome: a.profissionais?.nome || '?',
  }));
}

/** Cancela agendamento específico por ID. */
export async function cancelarAgendamentoPorId(id: string): Promise<void> {
  await supabase.from('agendamentos').update({ status: 'cancelado' }).eq('id', id);
}

/**
 * Cancela o próximo agendamento futuro do paciente. Útil quando há só 1.
 * Quando há múltiplos, o caller deve usar listarAgendamentosFuturos +
 * cancelarAgendamentoPorId pra evitar cancelar o errado.
 */
export async function cancelarAgendamentoPaciente(clinicaId: string, telefone: string): Promise<boolean> {
  const futuros = await listarAgendamentosFuturos(clinicaId, telefone);
  if (futuros.length === 0) return false;
  await cancelarAgendamentoPorId(futuros[0].id);
  return true;
}

/** Mark conversation for human handoff */
export async function marcarHandoff(clinicaId: string, telefone: string) {
  await supabase.from('conversas').upsert({
    clinica_id: clinicaId, paciente_telefone: telefone,
    etapa: 'handoff_humano', updated_at: new Date().toISOString(),
  }, { onConflict: 'clinica_id,paciente_telefone' });

  // Insert a notification for the clinic owner
  await supabase.from('notificacoes').insert({
    clinica_id: clinicaId, tipo: 'handoff_humano', telefone,
    mensagem: `Paciente ${telefone} solicitou falar com atendente humano`,
    enviado: false,
  });
}

export interface ConversaParaLimpar {
  id: string;
  clinica_id: string;
  paciente_telefone: string;
}

/**
 * Limpa conversas com updated_at < cutoff. Se onBeforeDelete for fornecido,
 * executa pra cada conversa antes de deletar (útil pra avisar o paciente).
 * Falhas no callback NÃO bloqueiam o delete.
 */
export async function limparConversasAntigas(
  hoursOld: number,
  onBeforeDelete?: (conv: ConversaParaLimpar) => Promise<void>
): Promise<number> {
  const cutoff = new Date(Date.now() - hoursOld * 3600000).toISOString();
  const { data } = await supabase.from('conversas')
    .select('id, clinica_id, paciente_telefone')
    .lt('updated_at', cutoff).not('etapa', 'eq', 'handoff_humano');
  if (!data || data.length === 0) return 0;

  if (onBeforeDelete) {
    for (const c of data as ConversaParaLimpar[]) {
      try { await onBeforeDelete(c); } catch { /* não bloqueia delete */ }
    }
  }

  const ids = data.map(c => c.id);
  await supabase.from('conversas').delete().in('id', ids);
  return ids.length;
}

/** Get per-PROFESSIONAL occupied slots (not global) */
export async function getOcupadosPorProfissional(clinicaId: string, desde: string, ate: string) {
  const { data } = await supabase.from('agendamentos')
    .select('profissional_id, data_hora, duracao_minutos')
    .eq('clinica_id', clinicaId).eq('status', 'confirmado')
    .gte('data_hora', desde).lte('data_hora', ate);
  return data || [];
}
