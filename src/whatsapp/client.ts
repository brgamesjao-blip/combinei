import { env } from '../config/env';
import { supabase } from '../db/client';
import { logger } from '../utils/logger';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export async function enviarMensagem(para: string, texto: string, instanceName?: string): Promise<boolean> {
  if (!env.EVOLUTION_API_URL) {
    logger.debug('EVO STUB', { phone: para, message: texto });
    return true;
  }

  let instance = instanceName;
  if (!instance) {
    const { data: clinica } = await supabase
      .from('clinicas').select('phone_number_id')
      .eq('ativa', true).limit(1).single();
    instance = clinica?.phone_number_id || 'default';
  }

  const numero = para.replace(/\D/g, '');

  // Typing indicator — makes the bot feel human
  try {
    fetch(`${env.EVOLUTION_API_URL}/chat/sendPresence/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: numero, presence: 'composing' }),
    }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch {}

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(
        `${env.EVOLUTION_API_URL}/message/sendText/${instance}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: env.EVOLUTION_API_KEY },
          body: JSON.stringify({ number: numero, text: texto }),
        }
      );

      if (response.ok) {
        logger.info('Mensagem enviada', { phone: para, instance });
        return true;
      }

      const errorText = await response.text();
      logger.warn('Erro Evolution API', { status: response.status, attempt: attempt + 1, error: errorText.substring(0, 100) });

      if (response.status >= 400 && response.status < 500) return false;
    } catch (err) {
      logger.error('Falha de rede Evolution', { phone: para, attempt: attempt + 1, error: (err as Error).message });
    }

    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }

  logger.error('Todas as tentativas falharam', { phone: para });
  return false;
}
