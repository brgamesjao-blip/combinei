function maskPhone(phone: string): string {
  if (!phone || phone.length < 6) return '***';
  return phone.slice(0, 4) + '****' + phone.slice(-2);
}

function sanitize(data?: Record<string, unknown>): Record<string, unknown> {
  if (!data) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (['phone', 'telefone', 'paciente_telefone'].includes(key)) {
      safe[key] = maskPhone(String(value || ''));
    } else if (['message', 'texto', 'mensagem', 'content'].includes(key)) {
      safe[key] = String(value || '').substring(0, 30) + '...';
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export const logger = {
  info(msg: string, data?: Record<string, unknown>): void {
    console.log(JSON.stringify({ level: 'info', ts: new Date().toISOString(), msg, ...sanitize(data) }));
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    console.warn(JSON.stringify({ level: 'warn', ts: new Date().toISOString(), msg, ...sanitize(data) }));
  },
  error(msg: string, data?: Record<string, unknown>): void {
    console.error(JSON.stringify({ level: 'error', ts: new Date().toISOString(), msg, ...sanitize(data) }));
  },
  debug(msg: string, data?: Record<string, unknown>): void {
    if (process.env.NODE_ENV === 'development') {
      console.log(JSON.stringify({ level: 'debug', ts: new Date().toISOString(), msg, ...sanitize(data) }));
    }
  },
};
