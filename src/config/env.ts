import dotenv from 'dotenv';
dotenv.config();

export const env = {
  PORT: process.env.PORT || '3000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  EVOLUTION_API_URL: process.env.EVOLUTION_API_URL || '',
  EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY || '',
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET || '',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:5173',
  WEBHOOK_URL: process.env.WEBHOOK_URL || '',
  NOTIFICATION_API_KEY: process.env.NOTIFICATION_API_KEY || '',
  CONVERSATION_TIMEOUT_HOURS: Number(process.env.CONVERSATION_TIMEOUT_HOURS) || 24,
  DASHBOARD_WEBHOOK_URL: process.env.DASHBOARD_WEBHOOK_URL || '',
} as const;

// Validate critical env vars at startup — warn loudly if missing (don't crash to allow healthcheck)
const required: Array<keyof typeof env> = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'WEBHOOK_SECRET'];
const missing = required.filter(k => !env[k]);
if (missing.length > 0) {
  console.error(JSON.stringify({ level: 'error', ts: new Date().toISOString(), msg: 'CRITICAL: missing env vars', missing }));
}
