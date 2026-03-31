# 🤖 Combinei Bot

Backend do Combinei — agendamento automático por WhatsApp para clínicas.

## Estrutura

```
src/
├── index.ts              → Servidor Express
├── config/
│   └── env.ts            → Variáveis de ambiente
├── ai/
│   ├── engine.ts         → Motor de IA (Claude) ✅
│   ├── prompts.ts        → System prompts ✅
│   └── test.ts           → Teste interativo no terminal ✅
├── whatsapp/
│   ├── client.ts         → Enviar/receber mensagens (stub)
│   └── webhook.ts        → Webhook do Meta (stub)
├── calendar/
│   └── client.ts         → Google Calendar (stub)
└── types/
    └── index.ts          → TypeScript types ✅
```

## Setup

```bash
# 1. Instalar dependências
npm install

# 2. Configurar ambiente
cp .env.example .env
# Preencha ANTHROPIC_API_KEY no .env

# 3. Testar a IA no terminal
npm run test:ai

# 4. Rodar o servidor
npm run dev
```

## Testar a IA

O comando `npm run test:ai` abre um chat interativo no terminal onde você pode conversar com o bot como se fosse um paciente. Exemplo:

```
📱 Paciente: Oi, quero marcar uma consulta
💬 Bot: Olá! Com qual profissional você gostaria de agendar? 
        Temos Dra. Ana Silva (Clínico Geral), Dr. Carlos Souza (Ortopedista) 
        e Dra. Beatriz Lima (Dermatologista).

📱 Paciente: Com a Dra. Ana, terça à tarde
💬 Bot: Terça temos os seguintes horários com a Dra. Ana:
        📌 14:00
        📌 15:30
        Qual prefere?

📱 Paciente: 15:30
💬 Bot: Combinei! ✅ Sua consulta com a Dra. Ana está marcada para 
        terça, 01/04 às 15:30. Envio um lembrete 24h antes!
```

## Roadmap

- [x] Fase 3 — IA conversacional (Claude)
- [ ] Fase 1 — WhatsApp (Meta Cloud API)
- [ ] Fase 2 — Google Calendar API
- [ ] Dashboard (Next.js)
- [ ] Banco de dados (Supabase)
