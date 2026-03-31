import * as readline from 'readline';
import * as fs from 'fs';
import { google } from 'googleapis';
import { env } from '../config/env';

// ═══════════════════════════════════════
// Teste interativo do Google Calendar
// Roda: npx tsx src/calendar/test.ts
// ═══════════════════════════════════════

const TOKENS_PATH = './calendar-tokens.json';

const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI
);

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

async function autenticar() {
  // Tentar carregar tokens salvos
  if (fs.existsSync(TOKENS_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
    oauth2Client.setCredentials(tokens);
    console.log('✅ Tokens carregados do arquivo.\n');
    return;
  }

  // Se não tem tokens, fazer OAuth
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });

  console.log('\n🔗 Abre esse link no navegador:\n');
  console.log(url);
  console.log('\nDepois de autorizar, o Google vai redirecionar pra uma página que vai dar erro.');
  console.log('Copia a URL da barra de endereço e cola aqui.\n');

  const redirectUrl = await ask('URL de redirecionamento: ');

  // Extrair o code da URL
  const urlObj = new URL(redirectUrl);
  const code = urlObj.searchParams.get('code');

  if (!code) {
    console.log('❌ Não encontrei o código na URL.');
    process.exit(1);
  }

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Salvar tokens pra não precisar autorizar de novo
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  console.log('\n✅ Google Calendar autorizado e tokens salvos!\n');
}

async function listarEventos() {
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: new Date().toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: 'America/Sao_Paulo',
  });

  const eventos = res.data.items || [];

  if (eventos.length === 0) {
    console.log('\n📭 Nenhum evento próximo encontrado.\n');
    return;
  }

  console.log('\n📅 Próximos eventos:\n');
  eventos.forEach((e, i) => {
    const inicio = e.start?.dateTime || e.start?.date || '';
    const data = new Date(inicio);
    const dataFormatada = data.toLocaleDateString('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    console.log(`  ${i + 1}. ${e.summary} — ${dataFormatada}`);
  });
  console.log('');
}

async function criarEvento() {
  const titulo = await ask('Título do evento: ');
  const data = await ask('Data (AAAA-MM-DD): ');
  const hora = await ask('Hora (HH:MM): ');
  const duracao = await ask('Duração em minutos (ex: 30): ');

  const inicio = new Date(`${data}T${hora}:00-03:00`);
  const fim = new Date(inicio.getTime() + parseInt(duracao) * 60000);

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: titulo,
      description: 'Agendado via Combinei (teste)',
      start: { dateTime: inicio.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: fim.toISOString(), timeZone: 'America/Sao_Paulo' },
      colorId: '2',
    },
  });

  console.log(`\n✅ Evento criado! ID: ${res.data.id}`);
  console.log(`   Link: ${res.data.htmlLink}\n`);
}

async function verificarDisponibilidade() {
  const data = await ask('Data pra verificar (AAAA-MM-DD): ');

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: new Date(`${data}T00:00:00-03:00`).toISOString(),
      timeMax: new Date(`${data}T23:59:59-03:00`).toISOString(),
      timeZone: 'America/Sao_Paulo',
      items: [{ id: 'primary' }],
    },
  });

  const ocupados = res.data.calendars?.primary?.busy || [];

  if (ocupados.length === 0) {
    console.log(`\n✅ Dia ${data} totalmente livre!\n`);
    return;
  }

  console.log(`\n📌 Horários ocupados em ${data}:\n`);
  ocupados.forEach(b => {
    const ini = new Date(b.start!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const fim = new Date(b.end!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    console.log(`  🔴 ${ini} — ${fim}`);
  });

  // Gerar slots livres (30min)
  console.log('\n  Slots disponíveis (30min):');
  const slots = [];
  for (let m = 8 * 60; m + 30 <= 18 * 60; m += 30) {
    const slotIni = new Date(`${data}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00-03:00`);
    const slotFim = new Date(slotIni.getTime() + 30 * 60000);

    const conflito = ocupados.some(b => {
      return slotIni < new Date(b.end!) && slotFim > new Date(b.start!);
    });

    if (!conflito) {
      const h = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      slots.push(h);
    }
  }
  console.log(`  🟢 ${slots.join(', ')}\n`);
}

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   📅 Combinei — Teste do Calendar    ║');
  console.log('╚══════════════════════════════════════╝\n');

  await autenticar();

  const loop = async () => {
    console.log('Comandos:');
    console.log('  1 — Listar próximos eventos');
    console.log('  2 — Criar um evento');
    console.log('  3 — Verificar disponibilidade de um dia');
    console.log('  4 — Sair\n');

    const opcao = await ask('Escolha: ');

    try {
      switch (opcao.trim()) {
        case '1': await listarEventos(); break;
        case '2': await criarEvento(); break;
        case '3': await verificarDisponibilidade(); break;
        case '4':
          console.log('\n👋 Encerrando.\n');
          rl.close();
          return;
        default:
          console.log('\nOpção inválida.\n');
      }
    } catch (error: any) {
      console.error('\n❌ Erro:', error.message || error, '\n');
    }

    loop();
  };

  loop();
}

main().catch(console.error);
