import express from 'express';
import { env } from './config/env';
import whatsappWebhook from './whatsapp/webhook';
import calendarRoutes from './calendar/routes';
import onboardingRoutes from './onboarding/routes';
import evolutionRoutes from './evolution/routes';

var app = express();
app.use(express.json());

app.get('/', function(_, res) { res.json({ name: 'Combinei Bot', status: 'online', v: '3.0' }); });

app.use(calendarRoutes);
app.use(whatsappWebhook);
app.use(onboardingRoutes);
app.use(evolutionRoutes);

var port = Number(env.PORT) || 3000;
app.listen(port, '0.0.0.0', function() {
  console.log('Combinei Bot v3 rodando na porta ' + port);
});
