import { Router } from 'express';
import { supabase } from '../db/client';
import { enviarMensagem } from '../whatsapp/client';

var router = Router();

// Cron endpoint — call every hour to send pending reminders
// Railway Cron or external service calls GET /api/notifications/process
router.get('/api/notifications/process', async function(req, res) {
  try {
    var agora = new Date();
    var em24h = new Date(agora.getTime() + 24 * 3600000);
    var em23h = new Date(agora.getTime() + 23 * 3600000);

    // Find appointments in next 23-24 hours that haven't been notified
    var { data: agendamentos } = await supabase.from('agendamentos')
      .select('*, profissionais(nome), clinicas(nome, phone_number_id, bot_nome)')
      .eq('status', 'confirmado')
      .gte('data_hora', em23h.toISOString())
      .lte('data_hora', em24h.toISOString());

    if (!agendamentos || agendamentos.length === 0) {
      res.json({ sent: 0 });
      return;
    }

    var enviados = 0;

    for (var i = 0; i < agendamentos.length; i++) {
      var a = agendamentos[i];

      // Check if already notified
      var { data: existing } = await supabase.from('notificacoes')
        .select('id')
        .eq('agendamento_id', a.id)
        .eq('tipo', 'lembrete_24h')
        .eq('enviado', true)
        .limit(1);

      if (existing && existing.length > 0) continue;

      var botNome = (a.clinicas as any)?.bot_nome || 'Bia';
      var clinicaNome = (a.clinicas as any)?.nome || 'Clínica';
      var instanceName = (a.clinicas as any)?.phone_number_id;
      if (!instanceName || !a.paciente_telefone) continue;

      var dtStr = a.data_hora ? a.data_hora.substring(0, 10) : '';
      var hrStr = a.data_hora ? a.data_hora.substring(11, 16) : '';
      var profNome = (a.profissionais as any)?.nome || 'profissional';

      var msg = 'Oi! Aqui é a ' + botNome + ' da ' + clinicaNome + ' 😊\n\n' +
        'Passando pra lembrar que você tem consulta amanhã:\n\n' +
        '👨‍⚕️ ' + profNome + '\n' +
        '📅 ' + dtStr.split('-').reverse().join('/') + '\n' +
        '⏰ ' + hrStr + '\n\n' +
        'Vai poder comparecer? Responda SIM pra confirmar ou NÃO pra cancelar.';

      try {
        await enviarMensagem(a.paciente_telefone, msg, instanceName);

        await supabase.from('notificacoes').insert({
          clinica_id: a.clinica_id,
          agendamento_id: a.id,
          tipo: 'lembrete_24h',
          telefone: a.paciente_telefone,
          mensagem: msg,
          enviado: true,
          enviado_at: new Date().toISOString(),
        });

        enviados++;
        console.log('Lembrete enviado: ' + a.paciente_nome + ' - ' + profNome);
      } catch (e: any) {
        console.error('Erro notificação:', e.message);
        await supabase.from('notificacoes').insert({
          clinica_id: a.clinica_id,
          agendamento_id: a.id,
          tipo: 'lembrete_24h',
          telefone: a.paciente_telefone,
          mensagem: msg,
          enviado: false,
        });
      }
    }

    res.json({ sent: enviados, total: agendamentos.length });
  } catch (e: any) {
    console.error('Notifications error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
