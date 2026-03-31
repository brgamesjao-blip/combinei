import { google, calendar_v3 } from 'googleapis';
import { env } from '../config/env';
import { HorarioDisponivel } from '../types';

// ═══════════════════════════════════════
// Google Calendar Client — IMPLEMENTAÇÃO REAL
// ═══════════════════════════════════════

const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI
);

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

/**
 * Gera a URL para a clínica autorizar acesso ao Google Calendar.
 */
export function gerarURLAutorizacao(): string {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });
}

/**
 * Troca o código de autorização por tokens de acesso.
 */
export async function trocarCodigoPorTokens(code: string) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  console.log('✅ Google Calendar autorizado com sucesso');

  // TODO: Salvar tokens no banco de dados (associado à clínica)
  return tokens;
}

/**
 * Configura tokens previamente salvos.
 */
export function configurarTokens(tokens: { access_token: string; refresh_token: string }) {
  oauth2Client.setCredentials(tokens);
}

/**
 * Busca horários disponíveis de um profissional.
 *
 * 1. Busca períodos ocupados no Calendar (freebusy)
 * 2. Gera todos os slots possíveis no horário de funcionamento
 * 3. Remove os que conflitam com eventos existentes
 * 4. Retorna os slots livres
 */
export async function buscarHorariosDisponiveis(
  calendarId: string,
  dataInicio: string,
  dataFim: string,
  duracaoConsultaMinutos: number = 30,
  horarioAbertura: string = '08:00',
  horarioFechamento: string = '18:00'
): Promise<HorarioDisponivel[]> {
  try {
    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(dataInicio + 'T00:00:00-03:00').toISOString(),
        timeMax: new Date(dataFim + 'T23:59:59-03:00').toISOString(),
        timeZone: 'America/Sao_Paulo',
        items: [{ id: calendarId }],
      },
    });

    const ocupados = freeBusy.data.calendars?.[calendarId]?.busy || [];

    const resultado: HorarioDisponivel[] = [];
    const inicio = new Date(dataInicio + 'T00:00:00-03:00');
    const fim = new Date(dataFim + 'T00:00:00-03:00');
    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

    for (let d = new Date(inicio); d <= fim; d.setDate(d.getDate() + 1)) {
      const diaSemana = d.getDay();
      if (diaSemana === 0 || diaSemana === 6) continue;

      const dataStr = d.toISOString().split('T')[0];
      const slots = gerarSlots(dataStr, horarioAbertura, horarioFechamento, duracaoConsultaMinutos);

      const slotsLivres = slots.filter(slot => {
        const slotInicio = new Date(`${dataStr}T${slot}:00-03:00`);
        const slotFim = new Date(slotInicio.getTime() + duracaoConsultaMinutos * 60000);

        return !ocupados.some(busy => {
          const busyInicio = new Date(busy.start!);
          const busyFim = new Date(busy.end!);
          return slotInicio < busyFim && slotFim > busyInicio;
        });
      });

      if (slotsLivres.length > 0) {
        resultado.push({
          data: dataStr,
          diaSemana: diasSemana[diaSemana],
          horarios: slotsLivres,
        });
      }
    }

    return resultado;
  } catch (error) {
    console.error('Erro ao buscar horários:', error);
    return [];
  }
}

/**
 * Cria um evento no Google Calendar.
 */
export async function criarEvento(
  calendarId: string,
  evento: {
    titulo: string;
    descricao: string;
    dataHoraInicio: string;  // "2026-04-01T15:30:00"
    duracaoMinutos: number;
    pacienteNome: string;
    pacienteTelefone: string;
  }
): Promise<string> {
  try {
    const inicio = new Date(evento.dataHoraInicio + '-03:00');
    const fim = new Date(inicio.getTime() + evento.duracaoMinutos * 60000);

    const res = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: evento.titulo,
        description: [
          `Paciente: ${evento.pacienteNome}`,
          `Telefone: ${evento.pacienteTelefone}`,
          `---`,
          `Agendado via Combinei`,
          evento.descricao,
        ].join('\n'),
        start: {
          dateTime: inicio.toISOString(),
          timeZone: 'America/Sao_Paulo',
        },
        end: {
          dateTime: fim.toISOString(),
          timeZone: 'America/Sao_Paulo',
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 },
            { method: 'popup', minutes: 1440 },
          ],
        },
        colorId: '2',
      },
    });

    console.log(`✅ Evento criado: ${res.data.id}`);
    return res.data.id || '';
  } catch (error) {
    console.error('Erro ao criar evento:', error);
    throw error;
  }
}

/**
 * Cancela um evento no Google Calendar.
 */
export async function cancelarEvento(
  calendarId: string,
  eventId: string
): Promise<void> {
  try {
    await calendar.events.delete({ calendarId, eventId });
    console.log(`✅ Evento cancelado: ${eventId}`);
  } catch (error) {
    console.error('Erro ao cancelar evento:', error);
    throw error;
  }
}

/**
 * Lista os próximos eventos de um calendário.
 */
export async function listarProximosEventos(
  calendarId: string,
  maxResults: number = 10
): Promise<calendar_v3.Schema$Event[]> {
  try {
    const res = await calendar.events.list({
      calendarId,
      timeMin: new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: 'America/Sao_Paulo',
    });

    return res.data.items || [];
  } catch (error) {
    console.error('Erro ao listar eventos:', error);
    return [];
  }
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function gerarSlots(
  data: string,
  abertura: string,
  fechamento: string,
  duracaoMinutos: number
): string[] {
  const slots: string[] = [];
  const [hAbre, mAbre] = abertura.split(':').map(Number);
  const [hFecha, mFecha] = fechamento.split(':').map(Number);

  let minutoAtual = hAbre * 60 + mAbre;
  const minutoFim = hFecha * 60 + mFecha;

  const agora = new Date();
  const dataSlot = new Date(data + 'T00:00:00-03:00');
  const ehHoje = dataSlot.toDateString() === agora.toDateString();

  while (minutoAtual + duracaoMinutos <= minutoFim) {
    const h = Math.floor(minutoAtual / 60);
    const m = minutoAtual % 60;
    const horario = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    if (ehHoje) {
      const horaAtual = agora.getHours() * 60 + agora.getMinutes();
      if (minutoAtual > horaAtual + 30) {
        slots.push(horario);
      }
    } else {
      slots.push(horario);
    }

    minutoAtual += duracaoMinutos;
  }

  return slots;
}
