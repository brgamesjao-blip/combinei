import { Router, Request, Response } from 'express';
import { enviarMensagem, marcarComoLida } from './client';
import { processarMensagem, criarContextoInicial } from '../ai/engine';
import { buscarConversa, salvarConversa, limparConversa, criarAgendamento, buscarTokensGoogle } from '../db/client';
import { criarEvento, configurarTokens, buscarHorariosDisponiveis } from '../calendar/client';
import { Clinica } from '../types';
import { supabase } from '../db/client';

// ═══════════════════════════════════════
// WhatsApp Webhook — Z-API + Calendar
// ═══════════════════════════════════════

const router = Router();

/**
 * POST /webhook — Recebe mensagens do Z-API
 */
router.post('/webhook', async (req: Request, res: Response) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.fromMe || body.isGroup) return;

    const texto = body.text?.message || body.body;
    if (!texto) return;

    const from = body.phone;
    const messageId = body.messageId;
    const instanceId = body.instanceId;

    console.log(`📩 Mensagem de ${from}: ${texto}`);

    // 1. Buscar clínica
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
        id: p.id,
        nome: p.nome,
        especialidade: p.especialidade,
        servicos: [],
      })),
      servicos: (servs || []).map(s => ({
        id: s.id,
        nome: s.nome,
        duracaoMinutos: s.duracao_minutos,
        preco: s.preco,
      })),
      horarioFuncionamento: {
        segunda: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        terca: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        quarta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        quinta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        sexta: { inicio: clinicaRow.horario_abertura, fim: clinicaRow.horario_fechamento },
        sabado: null,
        domingo: null,
      },
    };

    console.log(`🏥 Clínica: ${clinica.nome}`);

    // 2. Marcar como lida
    await marcarComoLida(messageId, from);

    // 3. Buscar ou criar contexto
    const conversaSalva = await buscarConversa(clinica.id, from);
    let contexto = criarContextoInicial(clinica);

    if (conversaSalva) {
      contexto.etapa = conversaSalva.etapa as any;
      contexto.dadosColetados = conversaSalva.dadosColetados;
      contexto.historicoMensagens = conversaSalva.historicoMensagens;
    }

    // 4. Carregar horários reais do Google Calendar (se conectado)
    const tokens = await buscarTokensGoogle(clinica.id);
    if (tokens) {
      try {
        configurarTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });

        const hoje = new Date();
        const daqui7dias = new Date(hoje.getTime() + 7 * 24 * 60 * 60 * 1000);
        const dataInicio = hoje.toISOString().split('T')[0];
        const dataFim = daqui7dias.toISOString().split('T')[0];

        contexto.horariosOferecidos = await buscarHorariosDisponiveis(
          tokens.calendar_id,
          dataInicio,
          dataFim,
          30,
          clinicaRow.horario_abertura,
          clinicaRow.horario_fechamento
        );

        console.log(`📅 Horários carregados: ${contexto.horariosOferecidos.length} dias disponíveis`);
      } catch (err) {
        console.error('⚠️ Erro ao buscar Calendar, usando horários padrão:', err);
        contexto.horariosOferecidos = gerarHorariosPadrao();
      }
    } else {
      console.log('⚠️ Google Calendar não conectado, usando horários padrão');
      contexto.horariosOferecidos = gerarHorariosPadrao();
    }

    // 5. Processar com IA
    const resultado = await processarMensagem(texto, contexto);

    // 6. Salvar conversa
    await salvarConversa(clinica.id, from, {
      etapa: resultado.contexto.etapa,
      dadosColetados: resultado.contexto.dadosColetados,
      historicoMensagens: resultado.contexto.historicoMensagens,
    });

    console.log(`💬 Resposta: ${resultado.resposta}`);

    // 7. Enviar resposta
    await enviarMensagem(from, resultado.resposta);

    // 8. Se agendamento concluído, criar evento no Calendar
    if (resultado.contexto.etapa === 'agendamento_concluido' && tokens) {
      try {
        const dados = resultado.contexto.dadosColetados;
        
        // Encontrar profissional
        const prof = clinica.profissionais.find(p => 
          p.nome.toLowerCase().includes((dados.profissional || '').toLowerCase())
        );

        // Montar data/hora do agendamento
        const dataHora = resolverDataHora(dados.data, dados.horario);

        if (dataHora && prof) {
          configurarTokens({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });

          // Criar evento no Google Calendar
          const eventId = await criarEvento(tokens.calendar_id, {
            titulo: `${prof.nome} — Consulta`,
            descricao: `Agendado via Combinei`,
            dataHoraInicio: dataHora,
            duracaoMinutos: 30,
            pacienteNome: dados.pacienteNome || 'Paciente',
            pacienteTelefone: from,
          });

          console.log(`📅 Evento criado no Calendar: ${eventId}`);

          // Salvar agendamento no banco
          await criarAgendamento({
            clinicaId: clinica.id,
            profissionalId: prof.id,
            pacienteNome: dados.pacienteNome || 'Paciente',
            pacienteTelefone: from,
            dataHora: dataHora,
            duracaoMinutos: 30,
            googleEventId: eventId,
          });

          console.log('✅ Agendamento salvo no banco');

          // Limpar conversa pra próxima interação
          await limparConversa(clinica.id, from);
        } else {
          console.log('⚠️ Não conseguiu resolver data/hora ou profissional pra criar evento');
        }
      } catch (err) {
        console.error('❌ Erro ao criar evento no Calendar:', err);
      }
    }

  } catch (error) {
    console.error('❌ Erro no webhook:', error);
  }
});

/**
 * GET /webhook — Health check
 */
router.get('/webhook', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

/**
 * Gera horários padrão quando Calendar não tá conectado.
 */
function gerarHorariosPadrao() {
  const dias = [];
  const hoje = new Date();

  for (let i = 1; i <= 5; i++) {
    const d = new Date(hoje.getTime() + i * 24 * 60 * 60 * 1000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    dias.push({
      data: d.toISOString().split('T')[0],
      diaSemana: diasSemana[d.getDay()],
      horarios: ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
    });
  }

  return dias;
}

/**
 * Resolve menções de data/hora naturais em ISO datetime.
 * Ex: "terça", "15:30" → "2026-04-01T15:30:00"
 */
function resolverDataHora(data?: string, horario?: string): string | null {
  if (!horario) return null;

  const hoje = new Date();
  let dataAlvo: Date | null = null;

  if (!data) {
    // Sem data, usa amanhã
    dataAlvo = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
  } else if (data.match(/^\d{4}-\d{2}-\d{2}$/)) {
    // Formato ISO
    dataAlvo = new Date(data + 'T00:00:00-03:00');
  } else if (data.match(/^\d{2}\/\d{2}$/)) {
    // Formato DD/MM
    const [dia, mes] = data.split('/').map(Number);
    dataAlvo = new Date(hoje.getFullYear(), mes - 1, dia);
  } else {
    // Tentar resolver dia da semana
    const diasMap: Record<string, number> = {
      'domingo': 0, 'segunda': 1, 'terca': 2, 'terça': 2,
      'quarta': 3, 'quinta': 4, 'sexta': 5, 'sabado': 6, 'sábado': 6,
      'amanha': 1, 'amanhã': 1,
    };

    const dataLower = data.toLowerCase().replace('-feira', '');
    
    if (dataLower === 'amanha' || dataLower === 'amanhã') {
      dataAlvo = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
    } else if (dataLower === 'hoje') {
      dataAlvo = hoje;
    } else {
      const diaAlvo = diasMap[dataLower];
      if (diaAlvo !== undefined) {
        dataAlvo = new Date(hoje);
        const diaAtual = hoje.getDay();
        let diff = diaAlvo - diaAtual;
        if (diff <= 0) diff += 7;
        dataAlvo.setDate(hoje.getDate() + diff);
      }
    }
  }

  if (!dataAlvo) return null;

  // Formatar: "2026-04-01T15:30:00"
  const ano = dataAlvo.getFullYear();
  const mes = String(dataAlvo.getMonth() + 1).padStart(2, '0');
  const dia = String(dataAlvo.getDate()).padStart(2, '0');

  // Normalizar horário
  const horaMatch = horario.match(/(\d{1,2}):?(\d{2})?/);
  if (!horaMatch) return null;

  const h = String(horaMatch[1]).padStart(2, '0');
  const m = horaMatch[2] || '00';

  return `${ano}-${mes}-${dia}T${h}:${m}:00`;
}

export default router;
