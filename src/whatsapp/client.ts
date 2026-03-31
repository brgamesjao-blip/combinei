import { env } from '../config/env';

// ═══════════════════════════════════════
// WhatsApp Client — Z-API
// ═══════════════════════════════════════

const BASE_URL = `https://api.z-api.io/instances/${env.ZAPI_INSTANCE_ID}/token/${env.ZAPI_TOKEN}`;

/**
 * Envia uma mensagem de texto.
 */
export async function enviarMensagem(para: string, texto: string): Promise<void> {
  if (!env.ZAPI_INSTANCE_ID || !env.ZAPI_TOKEN) {
    console.log(`[Z-API STUB] → ${para}: ${texto}`);
    return;
  }

  const response = await fetch(`${BASE_URL}/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': env.ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({
      phone: para,
      message: texto,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Erro Z-API:', error);
    throw new Error(`Z-API error: ${error}`);
  }

  console.log(`✅ Mensagem enviada pra ${para}`);
}

/**
 * Marca mensagem como lida.
 */
export async function marcarComoLida(messageId: string, phone: string): Promise<void> {
  if (!env.ZAPI_INSTANCE_ID) return;

  await fetch(`${BASE_URL}/read-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': env.ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({
      phone,
      messageId,
    }),
  }).catch(() => {});
}
