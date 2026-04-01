import { env } from '../config/env';
import { supabase } from '../db/client';

export async function enviarMensagem(para: string, texto: string, instanceName?: string) {
  if (!env.EVOLUTION_API_URL) {
    console.log('[EVO STUB] -> ' + para + ': ' + texto);
    return;
  }

  var instance = instanceName;
  if (!instance) {
    var { data: clinica } = await supabase.from('clinicas').select('phone_number_id').eq('ativa', true).limit(1).single();
    instance = clinica?.phone_number_id || 'default';
  }

  var numero = para.replace(/\D/g, '');

  var r = await fetch(env.EVOLUTION_API_URL + '/message/sendText/' + instance, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number: numero, text: texto }),
  });

  if (!r.ok) {
    var err = await r.text();
    console.error('Erro Evolution:', err);
  } else {
    console.log('Enviado pra ' + para);
  }
}

export async function marcarComoLida(messageId: string, phone: string) {
  // Evolution API marca como lida automaticamente
}
