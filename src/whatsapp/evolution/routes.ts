import { Router } from 'express';
import { env } from '../config/env';
import { supabase } from '../db/client';

var router = Router();

var EVO_URL = env.EVOLUTION_API_URL;
var EVO_KEY = env.EVOLUTION_API_KEY;

router.post('/evolution/create-instance', async function(req, res) {
  try {
    var { clinicaId, instanceName } = req.body;
    if (!clinicaId || !instanceName) {
      res.status(400).json({ error: 'clinicaId e instanceName obrigatorios' });
      return;
    }

    var webhookUrl = 'https://combinei-production.up.railway.app/webhook';

    var r = await fetch(EVO_URL + '/instance/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
      body: JSON.stringify({
        instanceName: instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        webhook: {
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: ['MESSAGES_UPSERT'],
        },
      }),
    });

    var data = await r.json();

    await supabase.from('clinicas').update({
      phone_number_id: instanceName,
      whatsapp_token: 'evolution',
    }).eq('id', clinicaId);

    res.json({ success: true, instance: data });
  } catch (e: any) {
    console.error('Erro criar instancia:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/evolution/qrcode/:instanceName', async function(req, res) {
  try {
    var name = req.params.instanceName;

    var r = await fetch(EVO_URL + '/instance/connect/' + name, {
      method: 'GET',
      headers: { 'apikey': EVO_KEY },
    });

    var data = await r.json();
    res.json(data);
  } catch (e: any) {
    console.error('Erro QR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/evolution/status/:instanceName', async function(req, res) {
  try {
    var name = req.params.instanceName;

    var r = await fetch(EVO_URL + '/instance/connectionState/' + name, {
      method: 'GET',
      headers: { 'apikey': EVO_KEY },
    });

    var data = await r.json();
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/evolution/instance/:instanceName', async function(req, res) {
  try {
    var name = req.params.instanceName;

    var r = await fetch(EVO_URL + '/instance/delete/' + name, {
      method: 'DELETE',
      headers: { 'apikey': EVO_KEY },
    });

    var data = await r.json();
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
