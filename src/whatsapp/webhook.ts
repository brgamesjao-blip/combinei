import { Router } from 'express';
import { enviarMensagem } from './client';
import { processarMensagem, criarContextoInicial } from '../ai/engine';
import { buscarConversa, salvarConversa, limparConversa, criarAgendamento, supabase } from '../db/client';
import { Clinica } from '../types';

var router = Router();

router.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    var body = req.body;
    var event = body.event;
    if (!event || event !== 'messages.upsert') return;

    var data = body.data;
    if (!data || !data.key) return;
    if (data.key.fromMe) return;

    var instanceName = body.instance;
    var remoteJid = data.key.remoteJid || '';
    if (remoteJid.includes('@g.us')) return;

    var phone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
    if (!phone) return;

    var texto = '';
    if (data.message) {
      texto = data.message.conversation || data.message.extendedTextMessage?.text || '';
    }

    if (!texto) { console.log('Midia de ' + phone + ', ignorando'); return; }

    console.log('Mensagem de ' + phone + ': ' + texto);

    var { data: clinicaRow } = await supabase
      .from('clinicas').select('*').eq('phone_number_id', instanceName).eq('ativa', true).single();

    if (!clinicaRow) {
      var { data: primeira } = await supabase
        .from('clinicas').select('*').eq('ativa', true).limit(1).single();
      clinicaRow = primeira;
    }

    if (!clinicaRow) { console.log('Sem clinica'); return; }

    var { data: profs } = await supabase
      .from('profissionais').select('*').eq('clinica_id', clinicaRow.id).eq('ativo', true);
    var { data: servs } = await supabase
      .from('servicos').select('*').eq('clinica_id', clinicaRow.id).eq('ativo', true);

    var clinica: Clinica = {
      id: clinicaRow.id, nome: clinicaRow.nome, telefone: clinicaRow.telefone || '',
      profissionais: (profs || []).map(function(p: any) { return { id: p.id, nome: p.nome, especialidade: p.especialidade, servicos: [] }; }),
      servicos: (servs || []).map(function(s: any) { return { id: s.id, nome: s.nome, duracaoMinutos: s.duracao_minutos, preco: s.preco }; }),
      horarioFuncionamento: {
        segunda: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        terca: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        quarta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        quinta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        sexta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        sabado: null, domingo: null,
      },
    };

    console.log('Clinica: ' + clinica.nome);

    var salva = await buscarConversa(clinica.id, phone);
    var ctx = criarContextoInicial(clinica);
    if (salva) {
      ctx.etapa = salva.etapa;
      ctx.dadosColetados = salva.dadosColetados;
      ctx.historicoMensagens = salva.historicoMensagens;
    }

    ctx.horariosOferecidos = gerarHorarios(clinicaRow.horario_abertura, clinicaRow.horario_fechamento, clinicaRow.almoco_inicio, clinicaRow.almoco_fim);

    // Check existing appointments to exclude booked slots
    var hoje = new Date();
    var fim = new Date(hoje.getTime() + 7 * 86400000);
    var { data: existentes } = await supabase.from('agendamentos')
      .select('data_hora, duracao_minutos')
      .eq('clinica_id', clinica.id).eq('status', 'confirmado')
      .gte('data_hora', hoje.toISOString().split('T')[0] + 'T00:00:00')
      .lte('data_hora', fim.toISOString().split('T')[0] + 'T23:59:59');

    if (existentes && existentes.length > 0) {
      ctx.horariosOferecidos = filtrarOcupados(ctx.horariosOferecidos, existentes);
    }

    var hist = '';
    var { data: antigos } = await supabase.from('agendamentos')
      .select('*, profissionais(nome)')
      .eq('clinica_id', clinica.id).eq('paciente_telefone', phone)
      .order('created_at', { ascending: false }).limit(5);
    if (antigos && antigos.length > 0) {
      hist = antigos.map(function(a: any) { return '- ' + (a.paciente_nome || 'Paciente') + ' com ' + ((a.profissionais as any)?.nome || '?') + ' em ' + new Date(a.data_hora).toLocaleDateString('pt-BR'); }).join('\n');
    }

    var resultado = await processarMensagem(texto, ctx, hist || undefined);

    await salvarConversa(clinica.id, phone, {
      etapa: resultado.contexto.etapa,
      dadosColetados: resultado.contexto.dadosColetados,
      historicoMensagens: resultado.contexto.historicoMensagens,
    });

    console.log('Resposta: ' + resultado.resposta);
    await enviarMensagem(phone, resultado.resposta, instanceName);

    if (resultado.contexto.etapa === 'agendamento_concluido') {
      try {
        var d = resultado.contexto.dadosColetados;

        var prof = clinica.profissionais.find(function(p) {
          var nomeProf = p.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          var busca = (d.profissional || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (nomeProf.includes(busca) || busca.includes(nomeProf)) return true;
          var palavras = busca.replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/i, '').split(/\s+/).filter(Boolean);
          return palavras.length > 0 && palavras.every(function(w) { return nomeProf.includes(w); });
        });

        var serv = clinica.servicos.find(function(s) {
          return (d.servico || '').toLowerCase().includes(s.nome.toLowerCase());
        });
        var duracao = serv ? serv.duracaoMinutos : (clinica.servicos.length > 0 ? clinica.servicos[0].duracaoMinutos : 30);

        var dt = resolverDataHora(d.data, d.horario);

        if (dt && prof) {
          await criarAgendamento({
            clinicaId: clinica.id, profissionalId: prof.id,
            pacienteNome: d.pacienteNome || 'Paciente', pacienteTelefone: phone,
            dataHora: dt, duracaoMinutos: duracao,
          });
          await limparConversa(clinica.id, phone);
          console.log('Agendamento salvo!');
        } else {
          console.log('Nao encontrou prof ou data — prof:', !!prof, 'dt:', dt);
        }
      } catch (e: any) { console.error('Salvar agendamento:', e.message); }
    }
  } catch (e: any) { console.error('Webhook:', e.message); }
});

router.get('/webhook', function(_, res) { res.json({ status: 'ok' }); });

function gerarHorarios(abertura?: string, fechamento?: string, almocoInicio?: string, almocoFim?: string) {
  var inicio = abertura || '08:00';
  var fim = fechamento || '18:00';
  var almI = almocoInicio || '12:00';
  var almF = almocoFim || '13:00';

  var hInicio = parseInt(inicio.split(':')[0]);
  var hFim = parseInt(fim.split(':')[0]);
  var hAlmI = parseInt(almI.split(':')[0]);
  var hAlmF = parseInt(almF.split(':')[0]);

  var dias: any[] = [];
  var nomes = ['Domingo','Segunda','Terca','Quarta','Quinta','Sexta','Sabado'];
  var hoje = new Date();

  for (var i = 1; i <= 7; i++) {
    var d = new Date(hoje.getTime() + i * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    var horarios: string[] = [];
    for (var h = hInicio; h < hFim; h++) {
      if (h >= hAlmI && h < hAlmF) continue;
      horarios.push(String(h).padStart(2, '0') + ':00');
      horarios.push(String(h).padStart(2, '0') + ':30');
    }

    dias.push({
      data: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'),
      diaSemana: nomes[d.getDay()],
      horarios: horarios,
    });
  }
  return dias;
}

function filtrarOcupados(horarios: any[], existentes: any[]) {
  var ocupados = new Set<string>();
  existentes.forEach(function(e) {
    var dt = new Date(e.data_hora);
    var key = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0') + '_' + String(dt.getHours()).padStart(2,'0') + ':' + String(dt.getMinutes()).padStart(2,'0');
    ocupados.add(key);
  });

  return horarios.map(function(dia) {
    return {
      ...dia,
      horarios: dia.horarios.filter(function(h: string) {
        return !ocupados.has(dia.data + '_' + h);
      }),
    };
  }).filter(function(dia) { return dia.horarios.length > 0; });
}

function resolverDataHora(data?: string, horario?: string): string | null {
  if (!horario && !data) return null;
  var hoje = new Date();
  var alvo: Date | null = null;

  if (!data) { alvo = new Date(hoje.getTime() + 86400000); }
  else if (data.match(/^\d{4}-\d{2}-\d{2}$/)) { alvo = new Date(data + 'T12:00:00'); }
  else if (data.match(/\d{2}\/\d{2}/)) {
    var m = data.match(/(\d{2})\/(\d{2})/);
    if (m) alvo = new Date(hoje.getFullYear(), +m[2] - 1, +m[1]);
  } else if (data.match(/dia\s*(\d{1,2})/i)) {
    var m2 = data.match(/dia\s*(\d{1,2})/i);
    if (m2) { alvo = new Date(hoje.getFullYear(), hoje.getMonth(), +m2[1]); if (alvo <= hoje) alvo.setMonth(alvo.getMonth() + 1); }
  } else {
    var map: any = { domingo:0, segunda:1, terca:2, 'terça':2, quarta:3, quinta:4, sexta:5, sabado:6, 'sábado':6 };
    var dl = data.toLowerCase().replace('-feira','').trim();
    if (dl === 'amanha' || dl === 'amanhã') alvo = new Date(hoje.getTime() + 86400000);
    else if (dl === 'depois de amanha' || dl === 'depois de amanhã') alvo = new Date(hoje.getTime() + 2 * 86400000);
    else if (dl === 'hoje') alvo = new Date(hoje);
    else if (dl === 'semana que vem') { alvo = new Date(hoje); var diff2 = 1 - hoje.getDay(); if (diff2 <= 0) diff2 += 7; alvo.setDate(hoje.getDate() + diff2); }
    else { var t = map[dl]; if (t !== undefined) { alvo = new Date(hoje); var diff = t - hoje.getDay(); if (diff <= 0) diff += 7; alvo.setDate(hoje.getDate() + diff); } }
  }
  if (!alvo) return null;

  var h = '09', mn = '00';
  if (horario) {
    var fm = horario.match(/(\d{1,2}):(\d{2})/);
    if (fm) {
      h = fm[1].padStart(2, '0');
      mn = fm[2];
    } else {
      var sm = horario.match(/(\d{1,2})/);
      if (sm) {
        var hr = +sm[1];
        if (horario.toLowerCase().includes('tarde') || horario.toLowerCase().includes('noite')) {
          if (hr < 12) hr += 12;
        } else if (horario.toLowerCase().includes('manhã') || horario.toLowerCase().includes('manha')) {
          // keep as is
        } else {
          if (hr <= 6) hr += 12;
        }
        h = String(hr).padStart(2, '0');
      }
      if (horario.toLowerCase().includes('meia') || horario.toLowerCase().includes('30')) {
        mn = '30';
      }
    }
  }
  return alvo.getFullYear() + '-' + String(alvo.getMonth()+1).padStart(2,'0') + '-' + String(alvo.getDate()).padStart(2,'0') + 'T' + h + ':' + mn + ':00-03:00';
}

export default router;
