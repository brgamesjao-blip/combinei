import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import whatsappWebhook from './whatsapp/webhook';
import onboardingRoutes from './onboarding/routes';
import evolutionRoutes from './evolution/routes';
import notificationRoutes from './notifications/routes';

var app = express();
app.use(cors());
app.use(express.json());

app.get('/', function(_, res) { res.json({ name: 'Combinei Bot', status: 'online', v: '4.1' }); });

app.use(whatsappWebhook);
app.use(onboardingRoutes);
app.use(evolutionRoutes);
app.use(notificationRoutes);

var port = Number(env.PORT) || 3000;
app.listen(port, '0.0.0.0', function() {
  console.log('Combinei Bot v4.1 rodando na porta ' + port);

  // Auto-check notifications every hour
  setInterval(async function() {
    try {
      var r = await fetch('http://localhost:' + port + '/api/notifications/process');
      var d = await r.json();
     if ((d as any).sent > 0) console.log('Notificacoes enviadas: ' + (d as any).sent);
    } catch(e) {}
  }, 3600000);
});
