import express from 'express';
import { env } from './config/env';
import whatsappWebhook from './whatsapp/webhook';
import calendarRoutes from './calendar/routes';

console.log('🚀 Iniciando Combinei Bot...');

const app = express();
app.use(express.json());

// Log TODA request que chega
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.path}`);
  next();
});

app.get('/', (_req, res) => {
  res.json({ name: 'Combinei Bot', status: 'online' });
});

app.use(calendarRoutes);
app.use(whatsappWebhook);

console.log('✅ Rotas carregadas');

const port = Number(env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`🤖 Combinei Bot rodando na porta ${port}`);
});
