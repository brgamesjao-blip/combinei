# Combinei Bot — Backend

## Stack
- Express/TypeScript no Railway (auto-deploy da branch main)
- Supabase (DB + Auth + RLS em todas as tabelas)
- Evolution API (WhatsApp via WHATSAPP-BAILEYS)
- Anthropic Claude (Sonnet 4 pra chat com temp 0.7, Haiku 4.5 pra extração)

## Arquitetura
- src/index.ts — Express server, CORS skip pra /webhook, graceful shutdown (SIGTERM/SIGINT)
- src/whatsapp/webhook.ts — Recebe mensagens da Evolution API, batching de 3s + serialização por batchKey, processa com AI, agenda
- src/whatsapp/client.ts — Envia mensagens via Evolution API com typing indicator + retries
- src/ai/engine.ts — Processa mensagens, extração com contexto (últimas 6 msgs), detecção de conclusão, prompt caching
- src/ai/prompts.ts — buildSystemPrompt retorna { static, dynamic } pra cache; extraction prompt
- src/db/client.ts — Supabase service_role client + CRUD functions
- src/evolution/routes.ts — Criar instância, QR code, status (SEMPRE inclui webhook secret)
- src/middleware/validateWebhook.ts — Valida apikey header com timingSafeEqual
- src/middleware/auth.ts — JWT auth via Supabase getUser()
- src/middleware/rateLimit.ts — Rate limit per IP (webhook: 300/min, api: 30/min, evolution: 10/min)
- src/notifications/routes.ts — Lembretes 24h + cleanup com aviso ao paciente (cron via UptimeRobot)
- src/export/routes.ts — CSV export de agendamentos/financeiro
- src/cache/routes.ts — POST /api/cache/invalidate (dashboard chama quando salvar mudanças)
- src/config/env.ts — Env vars com validação de críticas no startup
- src/utils/logger.ts — JSON structured logging com sanitização (phone mascarado, nome só primeiro)
- src/utils/cache.ts — TtlCache com 60s TTL (clinica, profissionais, serviços)
- src/utils/circuitBreaker.ts — Circuit breaker pra chamadas Anthropic
- src/utils/matchers.ts — matchProfissional com 3 tiers (exato/substring/palavras) + detecção de ambiguidade
- src/utils/parseHorario.ts — Parser robusto: dígito, extenso ("duas e meia"), "meio dia", "meia noite"

## Regras críticas
- NUNCA remover o CORS skip pra /webhook (Evolution API não envia Origin)
- NUNCA mudar o validateWebhook sem testar (já quebrou 3x)
- Webhook SEMPRE precisa do header apikey = WEBHOOK_SECRET
- Ao criar instância Evolution, SEMPRE incluir headers: {apikey: env.WEBHOOK_SECRET}
- Timezone: usar getBrazilNow() (UTC-3), NUNCA new Date() direto
- Detecção de agendamento: frases de confirmação + profissional + (data ou hora)
- DB usa service_role key (bypassa RLS)
- Intenção é preservada entre mensagens (não sobrescrever "agendar" com "outro")
- Confirmações curtas ("sim", "ok") retornam intencao "outro" na extração
- Profissional é re-extraído da resposta do AI (corrige erros de dadosColetados)
- Agendamento é criado DEPOIS de enviar confirmação — se falhar, envia follow-up pro paciente
- Histórico de conversa podado em 30 mensagens ao salvar no DB

## Features implementadas (sessão 14 abril 2026)

### Robustez crítica
- **Race em criarAgendamento**: partial UNIQUE INDEX em (profissional_id, data_hora) WHERE status='confirmado' (migration 002). Função detecta erro 23505 e re-throw mensagem clara
- **Stale conversation (>2h)**: limpa dadosColetados de booking (mantém só pacienteNome) — paciente não confirma agendamento velho com "sim"
- **JSON parsing robusto**: fallback regex {...} se parse direto falha, valida intencao contra enum, log estruturado
- **Profissional ambíguo**: matchProfissional helper detecta dois Joãos. Bot pergunta "Tem mais de um profissional aqui com esse nome: Dr. João Silva ou Dr. João Pereira. Com qual?"

### Robustez média
- **Serialização de batch por batchKey**: Promise chain garante que processarLote do mesmo paciente nunca roda em paralelo
- **Parser de horário robusto**: suporta "duas e meia", "meio dia", "meia noite", "vinte e duas", "treze horas"
- **Dashboard webhook com retry**: 3 tentativas exponenciais (1s/2s/4s), timeout 5s, log estruturado em falha
- **Logs pra mensagens ignoradas**: grupos (warn), status/newsletter (debug), reactions/edits/polls (info) + suporte a location/contact + truncamento >2000 chars

### Performance
- **Prompt caching** (Sonnet + Haiku): system prompt dividido em static (cacheable) + dynamic. Estimativa: ~80-90% economia de input tokens em chamadas dentro de 5min

### UX
- **Cleanup com aviso**: limparConversasAntigas tem callback onBeforeDelete. Cron envia "sua conversa expirou — me chama de novo" antes de deletar
- **Erros diferenciados**: 429/rate limit, 401/403, 529/overloaded, 5xx, circuit, timeout, anthropic, supabase — cada um com mensagem específica pro paciente saber se vale tentar logo ou esperar

### Inteligência conversacional (rodada 2)
- **Mudança de ideia mid-flow**: detecta sinais ("muda", "trocar", "outro", "na verdade", "melhor") combinados com campo afetado (profissional/dia/hora/servico/horarios). Se não veio novo valor na extração, deleta o campo pra não confirmar com dado obsoleto
- **Validação final de slot**: `validarSlot()` checa não-passado, dia atendimento, horário func, almoço, e duração não ultrapassa fechamento/invade almoço. Inválido → mensagem específica + reset etapa sem criar agendamento
- **Cancelamento ambíguo**: >1 agendamentos futuros + "cancela minha consulta" → lista numerada com data/hora/prof + pergunta qual. Extração de data/hora/prof específicos cancela direto. matchAgendamento aceita ordinais ("1", "primeira", "última")
- **Handler lembrete 24h**: detectarRespostaLembrete (com check de recência 30min e regex exata) interpreta SIM/NÃO ao "Vai poder comparecer?". NÃO → cancela + oferece remarcar. SIM → "te esperamos!"
- **Confirmações SMS-style**: extração reconhece "blz", "beleza", "tranquilo", "massa", "k", "vlw", "valeu", "perfeito", "show" como confirmação curta (intencao "outro", preserva intent anterior)

### Robustez extra (rodada 2)
- **Cap processedMessages**: hard limit 50k, remove 10k mais antigos quando estoura (Map insertion-ordered)
- **Batch hard timeout**: Promise.race 30s evita trava se processarLoteInner hang
- **Whitespace-only rejeitado**: `!texto || !texto.trim()` antes de virar batch
- **Cleanup preserva etapas ativas**: handoff_humano, cancelamento_solicitado, aguardando_confirmacao_24h
- **Sanitizar rawSample em logs**: mascarar "pacienteNome"/"profissional" no raw do Haiku pra não vazar PII (LGPD)

### ⚠️ Pendente
- Migration `002_unique_appointment_slot.sql` precisa ser aplicada manualmente no Supabase Dashboard. Antes, conferir duplicatas com:
  ```sql
  SELECT profissional_id, data_hora, COUNT(*) FROM agendamentos
  WHERE status='confirmado' GROUP BY 1,2 HAVING COUNT(*) > 1;
  ```

## Features implementadas (sessão 5-8 abril 2026)

### Inteligência do Bot
- Message batching (3s delay, max 10 msgs) — responde 1x só pra múltiplas msgs rápidas
- Extração com contexto conversacional (Haiku recebe últimas 6 mensagens)
- Seção "Inteligência Conversacional" no system prompt (não repetir perguntas, avançar rápido)
- pushName do WhatsApp — sugere "Seu nome é X?" em vez de perguntar do zero
- pushName como fallback de pacienteNome ao criar agendamento
- Pacientes retornando: sugere último profissional ("Quer com Dr. X de novo?")
- Histórico marca [AGENDADO FUTURO] / [PASSADO] / [CANCELADO] pra AI saber estado
- Slots de HOJE incluídos (filtra horários passados)
- Duração do serviço bloqueia slots adjacentes (60min = 2 slots)
- Remarcação auto-cancela agendamento anterior
- Follow-up "Precisa de mais alguma coisa?" após booking
- Confirmação final inclui duração e valor (regra 13 no prompt)
- Dias de atendimento dinâmicos no prompt (não hardcoded "Seg-Sex")
- horarioFunc busca primeiro dia útil (funciona pra clínicas que só atendem sábado)
- Suporte a mídia (áudio/imagem/vídeo/figurinha → resposta amigável, pula extração)
- Lower temperature 0.7 (respostas mais consistentes)
- Conversa abandonada (>2h gap) — AI cumprimenta de novo via system prompt (sem poluir histórico)
- Mensagens de erro por tipo (anthropic/supabase/timeout → textos diferentes)

### Segurança
- Detecção de emergência médica (keywords: emergência, dor forte, socorro, etc) → escalona pra humano + recomenda SAMU 192
- Fallback de clínica seguro (só usa se EXATAMENTE 1 clínica ativa)
- Validação de horário de almoço antes de criar agendamento (defense in depth)
- Validação de env vars críticas no startup (ANTHROPIC_API_KEY, SUPABASE_*, EVOLUTION_*, WEBHOOK_SECRET)
- PII mascarada nos logs (telefone: 5511****99, nome: só primeiro nome)
- Batch limitado a 10 mensagens (proteção contra spam)
- Rate limit webhook 300/min (Evolution API IP fixo, suporta múltiplos pacientes)

### Observabilidade
- Request IDs (reqId 8 chars) em todos os logs chave — grep por reqId = fluxo inteiro
- Stage tags (stage: "agendamento_concluido", "handoff", etc) nas logs
- Debug mode (NODE_ENV=development): loga prompts do AI e respostas (300 chars)
- Detecção de resposta vazia do AI com fallback

### Infra
- Graceful shutdown (SIGTERM/SIGINT) — drena batches pendentes até 15s antes de sair
- Cache invalidation endpoint (POST /api/cache/invalidate) — dashboard chama após salvar
- Cache TTL reduzido de 5min pra 60s (mudanças refletem rápido)
- QR code geração otimizada (removido sleep 2s, operações em paralelo)
- Dashboard webhook (DASHBOARD_WEBHOOK_URL) — POST fire-and-forget em handoff/emergência
- Typing indicator (composing presence) antes de enviar mensagem

### Bugs corrigidos
- Intenção sobrescrita por "outro" → preservar "agendar"/"cancelar" entre mensagens
- "sim" na extração → retorna "outro" (servidor preserva intenção anterior)
- "dia 5" no próprio dia 5 → bumped pra próximo mês (comparava tempo, não data)
- "DD/MM" no passado → não bumped pra próximo ano
- "segunda feira" (com espaço) → não reconhecido pelo parser
- Year crossover (confirmar janeiro em dezembro → year errado)
- Delete instance fire-and-forget → race condition com create (agora await)
- Profissional errado persistia em dadosColetados → re-extrai da resposta do AI
- Agendamento cancelado aparecia como [PASSADO] → agora [CANCELADO]
- Fallback de clínica pegava qualquer uma → só se exatamente 1 ativa
- Prompt hardcoded "Seg-Sex" / "Não atende Sábado" → dinâmico
- Resposta vazia do AI enviava string em branco → fallback
- processarLote sem catch → paciente nunca recebia resposta em erros
- Histórico crescia infinito → podado em 30 msgs
- Extração confusa com mídia ([O paciente enviou áudio]) → skip

## Variáveis Railway
ANTHROPIC_API_KEY, EVOLUTION_API_URL, EVOLUTION_API_KEY, SUPABASE_URL,
SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, WEBHOOK_SECRET,
NOTIFICATION_API_KEY, ALLOWED_ORIGINS, WEBHOOK_URL, CONVERSATION_TIMEOUT_HOURS,
DASHBOARD_WEBHOOK_URL (opcional), NODE_ENV, PORT

## URLs
- Backend: https://combinei-production.up.railway.app
- Evolution: https://evolution-api-production-3bba.up.railway.app
- Supabase: https://sqkjetwkxpycmazcrkhl.supabase.co
- Frontend: https://app.combinei.com

## API Endpoints

### Webhook
- POST /webhook — Recebe mensagens da Evolution API
- GET /webhook — Health check simples

### Onboarding
- POST /api/onboarding/clinica — Criar clínica (auth)
- POST /api/onboarding/profissional — Adicionar profissional (auth)
- POST /api/onboarding/servico — Adicionar serviço (auth)

### Evolution
- POST /evolution/create-instance — Criar instância WhatsApp (auth)
- GET /evolution/qrcode/:instanceName — Obter QR code (auth)
- GET /evolution/status/:instanceName — Status da conexão (auth)
- DELETE /evolution/instance/:instanceName — Deletar instância (auth)
- POST /evolution/fix-webhook/:instanceName — Reconectar webhook (auth)

### Cache
- POST /api/cache/invalidate — Invalidar cache de clínica (auth, body: {clinicaId})

### Notificações
- GET /api/notifications/process — Enviar lembretes 24h (api-key)
- GET /api/cleanup/conversas — Limpar conversas antigas (api-key)

### Export
- GET /api/export/agendamentos — CSV/JSON de agendamentos (auth, query: from, to, format)
- GET /api/export/financeiro — CSV financeiro (auth, query: from, to)

### Health
- GET / — Status do bot
- GET /health — Health check com status do DB

## Dashboard Webhook (DASHBOARD_WEBHOOK_URL)
Se configurada, o bot envia POST fire-and-forget em handoff/emergência:
```json
{
  "type": "handoff" | "emergency",
  "clinicaId": "uuid",
  "phone": "5511999999999",
  "timestamp": "2026-04-05T20:00:00.000Z",
  "keyword": "dor forte"  // só em emergency
}
```

## Convenções de código
- TypeScript strict
- Variáveis e funções em inglês, comentários podem ser em português
- Usar async/await, nunca callbacks
- Logs em JSON estruturado com sanitização de PII
- reqId em todos os logs chave pra rastreabilidade
