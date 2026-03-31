import express from 'express';
import { env } from './config/env';
import whatsappWebhook from './whatsapp/webhook';
import calendarRoutes from './calendar/routes';

// ═══════════════════════════════════════
// Combinei Bot — Servidor Principal
// ═══════════════════════════════════════

const app = express();

app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.json({
    name: 'Combinei Bot',
    status: 'online',
    version: '1.0.0',
  });
});

// Google Calendar OAuth
app.use(calendarRoutes);

// WhatsApp webhook
app.use(whatsappWebhook);

// Start
app.listen(env.PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║        🤖 Combinei Bot v1.0         ║
╠══════════════════════════════════════╣
║  Servidor rodando na porta ${String(env.PORT).padEnd(9)}║
║                                      ║
║  Endpoints:                          ║
║  GET  /                → Health      ║
║  GET  /auth/google     → Conectar    ║
║  GET  /webhook         → Verificação ║
║  POST /webhook         → Mensagens   ║
║                                      ║
║  Teste: npm run test:ai              ║
╚══════════════════════════════════════╝
  `);
});
