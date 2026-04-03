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

export async function criarAgendamento(a: any) {
  await supabase.from('agendamentos').insert({
    clinica_id: a.clinicaId,
    profissional_id: a.profissionalId,
    paciente_nome: a.pacienteNome,
    paciente_telefone: a.pacienteTelefone,
    data_hora: a.dataHora,
    duracao_minutos: a.duracaoMinutos,
    status: 'confirmado',
  });
}
