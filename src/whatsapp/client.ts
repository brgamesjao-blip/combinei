import { env } from '../config/env';

const BASE = `https://api.z-api.io/instances/${env.ZAPI_INSTANCE_ID}/token/${env.ZAPI_TOKEN}`;

export async function enviarMensagem(para: string, texto: string) {
  const r = await fetch(`${BASE}/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': env.ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone: para, message: texto }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.error('Erro Z-API:', err);
  } else {
    console.log(`✅ Enviado pra ${para}`);
  }
}

export async function marcarComoLida(messageId: string, phone: string) {
  await fetch(`${BASE}/read-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': env.ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone, messageId }),
  }).catch(() => {});
}
