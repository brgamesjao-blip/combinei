import { Router, Request, Response } from 'express';
import { enviarMensagem, marcarComoLida } from './client';
import { processarMensagem, criarContextoInicial } from '../ai/engine';
import { buscarConversa, salvarConversa, limparConversa, criarAgendamento, buscarTokensGoogle } from '../db/client';
import { criarEvento, configurarTokens, buscarHorariosDisponiveis } from '../calendar/client';
import { Clinica } from '../types';
import { supabase } from '../db/client';

const router = Router();

// ═══════════════════════════════════════
// Webhook principal — Z-API
// ═══════════════════════════════════════

router.post('/webhook', async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.fromMe || body.isGroup) return;

    const from = body.phone;
    const messageId = body.messageId;
    const instanceId = body.instanceId;

    // ─── Detectar tipo de mensagem ───
    const isAudio = body.audio || body.type === 'audio' || body.messageType === 'audio';
    const isImage = body.image || body.type === 'image' || body.messageType === 'image';
    const isVideo = body.video || body.type === 'video' || body.messageType === 'video';
    const isSticker = body.sticker || body.type === 'sticker' || body.messageType === 'sticker';
    const isDocument = body.document || body.type === 'document' || body.messageType === 'document';
    const isLocation = body.location || body.type === 'location';

    // Se não é texto, responde pedindo pra digitar
    if (isAudio) {
      await enviarMensagem(from, 'Desculpa, ainda não consigo ouvir áudios 😅 Pode digitar o que precisa? Prometo que respondo rapidinho!');
      return;
    }
    if (isImage || isVideo || isSticker) {
      await enviarMensagem(from, 'Opa, não consigo ver imagens ou vídeos por aqui! Me conta por texto o que você precisa? 😊');
      return;
    }
    if (isDocument) {
      await enviarMensagem(from, 'Não consigo abrir documentos, mas se precisar agendar uma consulta é só me dizer! 📅');
      return;
    }
    if (isLocation) {
      await enviarMensagem(from, 'Recebi sua localização! Mas pra agendar, me diz o dia e horário que prefere? 😊');
      return;
    }

    const texto = body.text?.message || body.body;
    if (!texto) return;

    console.log(`📩 Mensagem de ${from}: ${texto}`);

    // ─── 1. Buscar clínica ───
    let { data: clinicaRow } = await supabase
      .from('clinicas')
      .select('*')
      .eq('phone_number_id', instanceId)
      .eq('ativa', true)
      .single();

    if (!clinicaRow) {
      const { data: primeira } = await supabase
        .from('clinicas')
        .select('*')
        .eq('ativa', true)
        .limit(1)
        .single();
      clinicaRow = primeira;
    }

    if (!clinicaRow) {
      console.log('❌ Nenhuma clínica encontrada');
      return;
    }

    const { data: profs } = await supabase
      .from('profissionais')
      .select('*')
      .eq('clinica_id', clinicaRow.id)
      .eq('ativo', true);

    const { data: servs } = await supabase
      .from('servicos')
      .select('*')
      .eq('clinica_id', clinicaRow.id)
      .eq('ativo', true);

    const clinica: Clinica = {
      id: clinicaRow.id,
      nome: clinicaRow.nome,
      telefone: clinicaRow.telefone,
      profissionais: (profs || []).map(p => ({
        id: p.id, nome: p.nome, especialidade: p.especialidade, servicos: [],
      })),
      servicos: (servs || []).map(s => ({
        id: s.id, nome: s.nome, duracaoMinutos: s.duracao_minutos, preco: s.preco,
      })),
      horarioFuncionamento: {
        segunda: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        terca: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        quarta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        quinta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        sexta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        sabado: null, domingo: null,
      },
    };

    console.log(`🏥 Clínica: ${clinica.nome}`);

    // ─── 2. Marcar como lida ───
    await marcarComoLida(messageId, from);

    // ─── 3. Buscar histórico do paciente (agendamentos anteriores) ───
    let historicoPaciente = '';
    const { data: agendamentosAnteriores } = await supabase
      .from('agendamentos')
      .select('*, profissionais(nome)')
      .eq('clinica_id', clinica.id)
      .eq('paciente_telefone', from)
      .order('created_at', { ascending: false })
      .limit(5);

    if (agendamentosAnteriores && agendamentosAnteriores.length > 0) {
      historicoPaciente = agendamentosAnteriores.map(a => {
        const nome = a.paciente_nome || 'Paciente';
        const prof = (a.profissionais as any)?.nome || 'profissional';
        const data = new Date(a.data_hora).toLocaleDateString('pt-BR');
        const hora = new Date(a.data_hora).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `- ${nome} agendou com ${prof} em ${data} às ${hora} (status: ${a.status})`;
      }).join('\n');

      // Pegar o nome do paciente do histórico
      const nomeConhecido = agendamentosAnteriores[0]?.paciente_nome;
      if (nomeConhecido) {
        historicoPaciente = `Nome do paciente: ${nomeConhecido}\n\nAgendamentos anteriores:\n${historicoPaciente}`;
      }
    }

    // ─── 4. Buscar ou criar contexto ───
    const conversaSalva = await buscarConversa(clinica.id, from);
    let contexto = criarContextoInicial(clinica);

    if (conversaSalva) {
      contexto.etapa = conversaSalva.etapa as any;
      contexto.dadosColetados = conversaSalva.dadosColetados;
      contexto.historicoMensagens = conversaSalva.historicoMensagens;
    }

    // ─── 5. Carregar horários do Google Calendar ───
    const tokens = await buscarTokensGoogle(clinica.id);
    if (tokens) {
      try {
        configurarTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });

        const hoje = new Date();
        const daqui7dias = new Date(hoje.getTime() + 7 * 24 * 60 * 60 * 1000);

        contexto.horariosOferecidos = await buscarHorariosDisponiveis(
          tokens.calendar_id,
          hoje.toISOString().split('T')[0],
          daqui7dias.toISOString().split('T')[0],
          30,
          clinicaRow.horario_abertura,
          clinicaRow.horario_fechamento
        );

        console.log(`📅 ${contexto.horariosOferecidos.length} dias com horários disponíveis`);
      } catch (err) {
        console.error('⚠️ Erro Calendar:', err);
        contexto.horariosOferecidos = gerarHorariosPadrao();
      }
    } else {
      contexto.horariosOferecidos = gerarHorariosPadrao();
    }

    // ─── 6. Processar com IA (passando histórico do paciente) ───
    const resultado = await processarMensagem(texto, contexto, historicoPaciente || undefined);

    // ─── 7. Salvar conversa ───
    await salvarConversa(clinica.id, from, {
      etapa: resultado.contexto.etapa,
      dadosColetados: resultado.contexto.dadosColetados,
      historicoMensagens: resultado.contexto.historicoMensagens,
    });

    console.log(`💬 Resposta: ${resultado.resposta}`);

    // ─── 8. Enviar resposta ───
    await enviarMensagem(from, resultado.resposta);

    // ─── 9. Criar evento no Calendar se confirmou ───
    if (resultado.contexto.etapa === 'agendamento_concluido' && tokens) {
      try {
        const dados = resultado.contexto.dadosColetados;

        const prof = clinica.profissionais.find(p =>
          p.nome.toLowerCase().includes((dados.profissional || '').toLowerCase())
        );

        const dataHora = resolverDataHora(dados.data, dados.horario);

        if (dataHora && prof) {
          configurarTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });

          const eventId = await criarEvento(tokens.calendar_id, {
            titulo: `${prof.nome} — Consulta`,
            descricao: `Agendado via Combinei`,
            dataHoraInicio: dataHora,
            duracaoMinutos: 30,
            pacienteNome: dados.pacienteNome || 'Paciente',
            pacienteTelefone: from,
          });

          console.log(`📅 Evento criado: ${eventId}`);

          await criarAgendamento({
            clinicaId: clinica.id,
            profissionalId: prof.id,
            pacienteNome: dados.pacienteNome || 'Paciente',
            pacienteTelefone: from,
            dataHora: dataHora,
            duracaoMinutos: 30,
            googleEventId: eventId,
          });

          console.log('✅ Agendamento salvo');
          await limparConversa(clinica.id, from);
        }
      } catch (err) {
        console.error('❌ Erro ao criar evento:', err);
      }
    }

  } catch (error) {
    console.error('❌ Erro no webhook:', error);
  }
});

router.get('/webhook', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function gerarHorariosPadrao() {
  const dias = [];
  const hoje = new Date();
  const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

  for (let i = 1; i <= 7; i++) {
    const d = new Date(hoje.getTime() + i * 24 * 60 * 60 * 1000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    dias.push({
      data: d.toISOString().split('T')[0],
      diaSemana: diasSemana[d.getDay()],
      horarios: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
    });
  }

  return dias;
}

function resolverDataHora(data?: string, horario?: string): string | null {
  if (!horario) return null;

  const hoje = new Date();
  let dataAlvo: Date | null = null;

  if (!data) {
    dataAlvo = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
  } else if (data.match(/^\d{4}-\d{2}-\d{2}$/)) {
    dataAlvo = new Date(data + 'T00:00:00-03:00');
  } else if (data.match(/^\d{2}\/\d{2}$/)) {
    const [dia, mes] = data.split('/').map(Number);
    dataAlvo = new Date(hoje.getFullYear(), mes - 1, dia);
  } else {
    const diasMap: Record<string, number> = {
      'domingo': 0, 'segunda': 1, 'terca': 2, 'terça': 2,
      'quarta': 3, 'quinta': 4, 'sexta': 5, 'sabado': 6, 'sábado': 6,
    };

    const dataLower = data.toLowerCase().replace('-feira', '').trim();

    if (dataLower === 'amanha' || dataLower === 'amanhã') {
      dataAlvo = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
    } else if (dataLower === 'hoje') {
      dataAlvo = hoje;
    } else {
      const diaAlvo = diasMap[dataLower];
      if (diaAlvo !== undefined) {
        dataAlvo = new Date(hoje);
        let diff = diaAlvo - hoje.getDay();
        if (diff <= 0) diff += 7;
        dataAlvo.setDate(hoje.getDate() + diff);
      }
    }
  }

  if (!dataAlvo) return null;

  const ano = dataAlvo.getFullYear();
  const mes = String(dataAlvo.getMonth() + 1).padStart(2, '0');
  const dia = String(dataAlvo.getDate()).padStart(2, '0');

  const horaMatch = horario.match(/(\d{1,2}):?(\d{2})?/);
  if (!horaMatch) return null;

  const h = String(horaMatch[1]).padStart(2, '0');
  const m = horaMatch[2] || '00';

  return `${ano}-${mes}-${dia}T${h}:${m}:00`;
}

export default router;
