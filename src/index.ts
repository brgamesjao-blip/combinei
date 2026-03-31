import express from 'express';
import { env } from './config/env';
import whatsappWebhook from './whatsapp/webhook';
import calendarRoutes from './calendar/routes';
import onboardingRoutes from './onboarding/routes';

const app = express();
app.use(express.json());

app.get('/', (_, res) => res.json({ name: 'Combinei Bot', status: 'online', v: '2.0' }));
app.use(calendarRoutes);
app.use(whatsappWebhook);
app.use(onboardingRoutes);

const port = Number(env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`🤖 Combinei Bot v2 rodando na porta ${port}`);
});
