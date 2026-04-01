import { Router } from 'express';
import { enviarMensagem } from './client';
import { processarMensagem, criarContextoInicial } from '../ai/engine';
import { buscarConversa, salvarConversa, limparConversa, criarAgendamento, buscarTokensGoogle, supabase } from '../db/client';
import { criarEvento, configurarTokens, buscarHorariosDisponiveis, verificarSlotDisponivel } from '../calendar/client';
import { Clinica } from '../types';

const router = Router();

router.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const b = req.body;
    console.log(`📨 WEBHOOK: type=${b.type} fromMe=${b.fromMe} phone=${b.phone} text=${b.text?.message || b.body || ''}`);

    if (b.type === 'DeliveryCallback') return;
    if (b.type === 'MessageStatusCallback') return;
    if (b.fromMe) return;
    if (b.isGroup) return;
    if (!b.phone) return;

    const texto = b.text?.message || b.body;
    if (!texto) {
      console.log(`📩 Midia de ${b.phone}, ignorando`);
      return;
    }

    console.log(`📩 Texto de ${b.phone}: ${texto}`);

    let { data: clinicaRow } = await supabase
      .from('clinicas').select('*').eq('ativa', true).limit(1).single();

    if (!clinicaRow) { console.log('❌ Sem clinica'); return; }

    const { data: profs } = await supabase
      .from('profissionais').select('*').eq('clinica_id', clinicaRow.id).eq('ativo', true);
    const { data: servs } = await supabase
      .from('servicos').select('*').eq('clinica_id', clinicaRow.id).eq('ativo', true);

    const clinica: Clinica = {
      id: clinicaRow.id, nome: clinicaRow.nome, telefone: clinicaRow.telefone || '',
      profissionais: (profs || []).map((p: any) => ({ id: p.id, nome: p.nome, especialidade: p.especialidade, servicos: [] })),
      servicos: (servs || []).map((s: any) => ({ id: s.id, nome: s.nome, duracaoMinutos: s.duracao_minutos, preco: s.preco })),
      horarioFuncionamento: {
        segunda: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        terca: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        quarta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        quinta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        sexta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        sabado: null, domingo: null,
      },
    };

    console.log(`🏥 ${clinica.nome}`);

    const salva = await buscarConversa(clinica.id, b.phone);
    let ctx = criarContextoInicial(clinica);
    if (salva) {
      ctx.etapa = salva.etapa;
      ctx.dadosColetados = salva.dadosColetados;
      ctx.historicoMensagens = salva.historicoMensagens;
    }

    const tokens = await buscarTokensGoogle(clinica.id);
    if (tokens) {
      try {
        configurarTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }, clinica.id);
        const hoje = new Date();
        const fim = new Date(hoje.getTime() + 7 * 86400000);
        ctx.horariosOferecidos = await buscarHorariosDisponiveis(
          tokens.calendar_id, hoje.toISOString().split('T')[0], fim.toISOString().split('T')[0],
          30, clinicaRow.horario_abertura, clinicaRow.horario_fechamento
        );
      } catch (e) { ctx.horariosOferecidos = gerarHorarios(); }
    } else {
      ctx.horariosOferecidos = gerarHorarios();
    }

    let hist = '';
    const { data: antigos } = await supabase.from('agendamentos')
      .select('*, profissionais(nome)')
      .eq('clinica_id', clinica.id).eq('paciente_telefone', b.phone)
      .order('created_at', { ascending: false }).limit(5);
    if (antigos && antigos.length > 0) {
      hist = antigos.map((a: any) => `- ${a.paciente_nome || 'Paciente'} com ${(a.profissionais as any)?.nome || '?'} em ${new Date(a.data_hora).toLocaleDateString('pt-BR')}`).join('\n');
    }

    const resultado = await processarMensagem(texto, ctx, hist || undefined);

    await salvarConversa(clinica.id, b.phone, {
      etapa: resultado.contexto.etapa,
      dadosColetados: resultado.contexto.dadosColetados,
      historicoMensagens: resultado.contexto.historicoMensagens,
    });

    console.log(`💬 ${resultado.resposta}`);
    await enviarMensagem(b.phone, resultado.resposta);

    if (resultado.contexto.etapa === 'agendamento_concluido' && tokens) {
      try {
        const d = resultado.contexto.dadosColetados;
        const prof = clinica.profissionais.find(p => p.nome.toLowerCase().includes((d.profissional || '').toLowerCase()));
        const dt = resolverDataHora(d.data, d.horario);

        if (dt && prof) {
          configurarTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }, clinica.id);

          const disponivel = await verificarSlotDisponivel(tokens.calendar_id, dt, 30);

          if (!disponivel) {
            await enviarMensagem(b.phone, 'Ops! Esse horario acabou de ser ocupado por outro paciente 😕 Quer que eu te mostre outros horarios disponiveis?');
            console.log('⚠️ Slot conflitante');
            await salvarConversa(clinica.id, b.phone, {
              etapa: 'coletar_horario',
              dadosColetados: { ...resultado.contexto.dadosColetados, horario: undefined },
              historicoMensagens: resultado.contexto.historicoMensagens,
            });
          } else {
            const eid = await criarEvento(tokens.calendar_id, {
              titulo: prof.nome + ' — Consulta', descricao: 'Via Combinei',
              dataHoraInicio: dt, duracaoMinutos: 30,
              pacienteNome: d.pacienteNome || 'Paciente', pacienteTelefone: b.phone,
            });
            console.log('📅 Evento: ' + eid);
            await criarAgendamento({
              clinicaId: clinica.id, profissionalId: prof.id,
              pacienteNome: d.pacienteNome || 'Paciente', pacienteTelefone: b.phone,
              dataHora: dt, duracaoMinutos: 30, googleEventId: eid,
            });
            await limparConversa(clinica.id, b.phone);
            console.log('✅ Salvo');
          }
        }
      } catch (e: any) { console.error('❌ Calendar:', e.message); }
    }
  } catch (e: any) { console.error('❌ Webhook:', e.message); }
});

router.get('/webhook', (_, res) => res.json({ status: 'ok' }));

function gerarHorarios() {
  const dias: any[] = [];
  const nomes = ['Domingo','Segunda','Terca','Quarta','Quinta','Sexta','Sabado'];
  const hoje = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(hoje.getTime() + i * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    dias.push({ data: d.toISOString().split('T')[0], diaSemana: nomes[d.getDay()], horarios: ['09:00','10:00','11:00','14:00','15:00','16:00'] });
  }
  return dias;
}

function resolverDataHora(data?: string, horario?: string): string | null {
  if (!horario && !data) return null;
  const hoje = new Date();
  let alvo: Date | null = null;

  if (!data) { alvo = new Date(hoje.getTime() + 86400000); }
  else if (data.match(/^\d{4}-\d{2}-\d{2}$/)) { alvo = new Date(data); }
  else if (data.match(/\d{2}\/\d{2}/)) {
    const m = data.match(/(\d{2})\/(\d{2})/);
    if (m) alvo = new Date(hoje.getFullYear(), +m[2] - 1, +m[1]);
  } else if (data.match(/dia\s*(\d{1,2})/i)) {
    const m = data.match(/dia\s*(\d{1,2})/i);
    if (m) { alvo = new Date(hoje.getFullYear(), hoje.getMonth(), +m[1]); if (alvo <= hoje) alvo.setMonth(alvo.getMonth() + 1); }
  } else {
    const map: any = { domingo:0, segunda:1, terca:2, 'terça':2, quarta:3, quinta:4, sexta:5, sabado:6, 'sábado':6 };
    const dl = data.toLowerCase().replace('-feira','').trim();
    if (dl === 'amanha' || dl === 'amanhã') alvo = new Date(hoje.getTime() + 86400000);
    else if (dl === 'hoje') alvo = hoje;
    else { const t = map[dl]; if (t !== undefined) { alvo = new Date(hoje); let diff = t - hoje.getDay(); if (diff <= 0) diff += 7; alvo.setDate(hoje.getDate() + diff); } }
  }
  if (!alvo) return null;

  let h = '09', m = '00';
  if (horario) {
    const fm = horario.match(/(\d{1,2}):(\d{2})/);
    const sm = horario.match(/(\d{1,2})\s*(?:h|da|$)/i);
    if (fm) { h = fm[1].padStart(2,'0'); m = fm[2]; }
    else if (sm) { let hr = +sm[1]; if (horario.toLowerCase().includes('tarde') || horario.toLowerCase().includes('noite')) { if (hr < 12) hr += 12; } if (hr < 7) hr += 12; h = String(hr).padStart(2,'0'); }
  }
  return `${alvo.getFullYear()}-${String(alvo.getMonth()+1).padStart(2,'0')}-${String(alvo.getDate()).padStart(2,'0')}T${h}:${m}:00`;
}

export default router;
