import dotenv from 'dotenv';
dotenv.config();

export const env = {
  PORT: process.env.PORT || 3000,

  // Anthropic (Claude)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',

  // Z-API (WhatsApp)
  ZAPI_INSTANCE_ID: process.env.ZAPI_INSTANCE_ID || '',
  ZAPI_TOKEN: process.env.ZAPI_TOKEN || '',
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN || '',

  // Google Calendar
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || '',

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_KEY: process.env.SUPABASE_KEY || '',
};
