import { google } from 'googleapis';
import { env } from '../config/env';
import { HorarioDisponivel } from '../types';

const oauth2Client = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

export function gerarURLAutorizacao(): string {
  return oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'] });
}

export async function trocarCodigoPorTokens(code: string) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  return tokens;
}

export function configurarTokens(tokens: { access_token: string; refresh_token: string }) {
  oauth2Client.setCredentials(tokens);
}

export async function buscarHorariosDisponiveis(calendarId: string, dataInicio: string, dataFim: string, duracao: number = 30, abertura: string = '08:00', fechamento: string = '18:00'): Promise<HorarioDisponivel[]> {
  try {
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(dataInicio + 'T00:00:00-03:00').toISOString(),
        timeMax: new Date(dataFim + 'T23:59:59-03:00').toISOString(),
        timeZone: 'America/Sao_Paulo', items: [{ id: calendarId }],
      },
    });
    const busy = fb.data.calendars?.[calendarId]?.busy || [];
    const result: HorarioDisponivel[] = [];
    const nomes = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const ini = new Date(dataInicio); const fim = new Date(dataFim);
    for (let d = new Date(ini); d <= fim; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const ds = d.toISOString().split('T')[0];
      const slots = gerarSlots(ds, abertura, fechamento, duracao);
      const livres = slots.filter(s => {
        const si = new Date(`${ds}T${s}:00-03:00`); const sf = new Date(si.getTime() + duracao * 60000);
        return !busy.some(b => si < new Date(b.end!) && sf > new Date(b.start!));
      });
      if (livres.length > 0) result.push({ data: ds, diaSemana: nomes[d.getDay()], horarios: livres });
    }
    return result;
  } catch (e) { return []; }
}

export async function criarEvento(calendarId: string, ev: { titulo: string; descricao: string; dataHoraInicio: string; duracaoMinutos: number; pacienteNome: string; pacienteTelefone: string }): Promise<string> {
  const ini = new Date(ev.dataHoraInicio + '-03:00');
  const fim = new Date(ini.getTime() + ev.duracaoMinutos * 60000);
  const r = await calendar.events.insert({
    calendarId, requestBody: {
      summary: ev.titulo, description: `Paciente: ${ev.pacienteNome}\nTel: ${ev.pacienteTelefone}\n\n${ev.descricao}`,
      start: { dateTime: ini.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: fim.toISOString(), timeZone: 'America/Sao_Paulo' },
      colorId: '2',
    },
  });
  return r.data.id || '';
}

function gerarSlots(data: string, abertura: string, fechamento: string, duracao: number): string[] {
  const slots: string[] = [];
  const [ha, ma] = abertura.split(':').map(Number); const [hf, mf] = fechamento.split(':').map(Number);
  let min = ha * 60 + ma; const maxMin = hf * 60 + mf;
  const agora = new Date(); const ehHoje = new Date(data).toDateString() === agora.toDateString();
  while (min + duracao <= maxMin) {
    const h = Math.floor(min / 60); const m = min % 60;
    const hr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (!ehHoje || min > agora.getHours() * 60 + agora.getMinutes() + 30) slots.push(hr);
    min += duracao;
  }
  return slots;
}
