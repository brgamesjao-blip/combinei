# Combinei Bot — Backend

## Stack
- Express/TypeScript no Railway (auto-deploy da branch main)
- Supabase (DB + Auth + RLS em todas as tabelas)
- Evolution API (WhatsApp via WHATSAPP-BAILEYS)
- Anthropic Claude (Sonnet pra chat, Haiku pra extração)

## Arquitetura
- src/index.ts — Express server, CORS skip pra /webhook
- src/whatsapp/webhook.ts — Recebe mensagens da Evolution API, processa com AI, agenda
- src/ai/engine.ts — Processa mensagens, detecta conclusão de agendamento (11 frases)
- src/ai/prompts.ts — System prompt pro bot + extraction prompt
- src/db/client.ts — Supabase service_role client + CRUD functions
- src/evolution/routes.ts — Criar instância, QR code, status (SEMPRE inclui webhook secret)
- src/middleware/validateWebhook.ts — Valida apikey header com timingSafeEqual
- src/middleware/auth.ts — JWT auth via Supabase getUser()
- src/notifications/routes.ts — Lembretes 24h (cron via UptimeRobot)
- src/export/routes.ts — CSV export de agendamentos/financeiro

## Regras críticas
- NUNCA remover o CORS skip pra /webhook (Evolution API não envia Origin)
- NUNCA mudar o validateWebhook sem testar (já quebrou 3x)
- Webhook SEMPRE precisa do header apikey = WEBHOOK_SECRET
- Ao criar instância Evolution, SEMPRE incluir headers: {apikey: env.WEBHOOK_SECRET}
- Timezone: usar getBrazilNow() (UTC-3), NUNCA new Date() direto
- Detecção de agendamento: 11 frases, exige profissional + (data ou hora)
- DB usa service_role key (bypassa RLS)

## Variáveis Railway
ANTHROPIC_API_KEY, EVOLUTION_API_URL, EVOLUTION_API_KEY, SUPABASE_URL,
SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, WEBHOOK_SECRET,
NOTIFICATION_API_KEY, ALLOWED_ORIGINS, WEBHOOK_URL, CONVERSATION_TIMEOUT_HOURS,
NODE_ENV, PORT

## URLs
- Backend: https://combinei-production.up.railway.app
- Evolution: https://evolution-api-production-3bba.up.railway.app
- Supabase: https://sqkjetwkxpycmazcrkhl.supabase.co
- Frontend: https://app.combinei.com
