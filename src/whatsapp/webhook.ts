import { Router } from 'express';
import { enviarMensagem } from './client';
import { processarMensagem, criarContextoInicial } from '../ai/engine';
import { buscarConversa, salvarConversa, limparConversa, criarAgendamento, buscarTokensGoogle, supabase } from '../db/client';
import { criarEvento, configurarTokens, buscarHorariosDisponiveis, verificarSlotDisponivel } from '../calendar/client';
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

    if (!texto) {
      console.log('Midia de ' + phone + ', ignorando');
      return;
    }

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

    var tokens = await buscarTokensGoogle(clinica.id);
    if (tokens) {
      try {
        configurarTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }, clinica.id);
        var hoje = new Date();
        var fim = new Date(hoje.getTime() + 7 * 86400000);
        ctx.horariosOferecidos = await buscarHorariosDisponiveis(
          tokens.calendar_id, hoje.toISOString().split('T')[0], fim.toISOString().split('T')[0],
          30, clinicaRow.horario_abertura, clinicaRow.horario_fechamento,
          clinicaRow.almoco_inicio, clinicaRow.almoco_fim
        );
      } catch (e) { ctx.horariosOferecidos = gerarHorarios(); }
    } else {
      ctx.horariosOferecidos = gerarHorarios();
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

    if (resultado.contexto.etapa === 'agendamento_concluido' && tokens) {
      try {
        var d = resultado.contexto.dadosColetados;

        var prof = clinica.profissionais.find(function(p) {
          var nomeProf = p.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          var busca = (d.profissional || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (nomeProf.includes(busca) || busca.includes(nomeProf)) return true;
          var palavras = busca.replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/i, '').split(/\s+/).filter(Boolean);
          return palavras.length > 0 && palavras.every(function(w) { return nomeProf.includes(w); });
        });

        var dt = resolverDataHora(d.data, d.horario);

        if (dt && prof) {
          configurarTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }, clinica.id);

          var disponivel = await verificarSlotDisponivel(tokens.calendar_id, dt, 30);

          if (!disponivel) {
            await enviarMensagem(phone, 'Ops! Esse horario acabou de ser ocupado 😕 Quer que eu te mostre outros horarios?', instanceName);
            await salvarConversa(clinica.id, phone, {
              etapa: 'coletar_horario',
              dadosColetados: { ...resultado.contexto.dadosColetados, horario: undefined },
              historicoMensagens: resultado.contexto.historicoMensagens,
            });
          } else {
            var eid = await criarEvento(tokens.calendar_id, {
              titulo: prof.nome + ' — Consulta', descricao: 'Via Combinei',
              dataHoraInicio: dt, duracaoMinutos: 30,
              pacienteNome: d.pacienteNome || 'Paciente', pacienteTelefone: phone,
            });
            console.log('Evento: ' + eid);
            await criarAgendamento({
              clinicaId: clinica.id, profissionalId: prof.id,
              pacienteNome: d.pacienteNome || 'Paciente', pacienteTelefone: phone,
              dataHora: dt, duracaoMinutos: 30, googleEventId: eid,
            });
            await limparConversa(clinica.id, phone);
            console.log('Salvo');
          }
        }
      } catch (e: any) { console.error('Calendar:', e.message); }
    }
  } catch (e: any) { console.error('Webhook:', e.message); }
});

router.get('/webhook', function(_, res) { res.json({ status: 'ok' }); });

function gerarHorarios() {
  var dias: any[] = [];
  var nomes = ['Domingo','Segunda','Terca','Quarta','Quinta','Sexta','Sabado'];
  var hoje = new Date();
  for (var i = 1; i <= 7; i++) {
    var d = new Date(hoje.getTime() + i * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    dias.push({ data: d.toISOString().split('T')[0], diaSemana: nomes[d.getDay()], horarios: ['09:00','10:00','11:00','14:00','15:00','16:00'] });
  }
  return dias;
}

function resolverDataHora(data?: string, horario?: string): string | null {
  if (!horario && !data) return null;
  var hoje = new Date();
  var alvo: Date | null = null;

  if (!data) { alvo = new Date(hoje.getTime() + 86400000); }
  else if (data.match(/^\d{4}-\d{2}-\d{2}$/)) { alvo = new Date(data); }
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
    else if (dl === 'hoje') alvo = hoje;
    else { var t = map[dl]; if (t !== undefined) { alvo = new Date(hoje); var diff = t - hoje.getDay(); if (diff <= 0) diff += 7; alvo.setDate(hoje.getDate() + diff); } }
  }
  if (!alvo) return null;

  var h = '09', mn = '00';
  if (horario) {
    var fm = horario.match(/(\d{1,2}):(\d{2})/);
    var sm = horario.match(/(\d{1,2})\s*(?:h|da|$)/i);
    if (fm) { h = fm[1].padStart(2,'0'); mn = fm[2]; }
    else if (sm) { var hr = +sm[1]; if (horario.toLowerCase().includes('tarde') || horario.toLowerCase().includes('noite')) { if (hr < 12) hr += 12; } if (hr < 7) hr += 12; h = String(hr).padStart(2,'0'); }
  }
  return alvo.getFullYear() + '-' + String(alvo.getMonth()+1).padStart(2,'0') + '-' + String(alvo.getDate()).padStart(2,'0') + 'T' + h + ':' + mn + ':00';
}

export default router;
