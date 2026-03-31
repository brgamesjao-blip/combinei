import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

export async function buscarConversa(clinicaId: string, telefone: string) {
  const { data } = await supabase
    .from('conversas')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('paciente_telefone', telefone)
    .single();
  if (!data) return null;
  return {
    etapa: data.etapa,
    dadosColetados: data.dados_coletados || {},
    historicoMensagens: data.historico_mensagens || [],
  };
}

export async function salvarConversa(clinicaId: string, telefone: string, ctx: any) {
  await supabase.from('conversas').upsert({
    clinica_id: clinicaId,
    paciente_telefone: telefone,
    etapa: ctx.etapa,
    dados_coletados: ctx.dadosColetados,
    historico_mensagens: ctx.historicoMensagens,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'clinica_id,paciente_telefone' });
}

export async function limparConversa(clinicaId: string, telefone: string) {
  await supabase.from('conversas').delete()
    .eq('clinica_id', clinicaId)
    .eq('paciente_telefone', telefone);
}

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

export async function salvarTokensGoogle(clinicaId: string, tokens: any) {
  const update: any = {};
  if (tokens.access_token) update.google_access_token = tokens.access_token;
  if (tokens.refresh_token) update.google_refresh_token = tokens.refresh_token;
  await supabase.from('clinicas').update(update).eq('id', clinicaId);
}

export async function criarAgendamento(a: any) {
  await supabase.from('agendamentos').insert({
    clinica_id: a.clinicaId,
    profissional_id: a.profissionalId,
    paciente_nome: a.pacienteNome,
    paciente_telefone: a.pacienteTelefone,
    data_hora: a.dataHora,
    duracao_minutos: a.duracaoMinutos,
    google_event_id: a.googleEventId,
    status: 'confirmado',
  });
}
