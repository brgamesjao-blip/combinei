# Combinei API Documentation v6

Base URL: `https://your-backend.railway.app`

---

## Authentication

All routes (except `/webhook` and `/health`) require a Bearer token from Supabase Auth.

```
Authorization: Bearer <supabase_access_token>
```

Cron endpoints (`/api/notifications/*`, `/api/cleanup/*`) use a static API key:

```
x-api-key: <NOTIFICATION_API_KEY>
```

---

## Public Endpoints

### `GET /`
Health check (basic).
```json
{ "name": "Combinei Bot", "status": "online", "v": "6.0" }
```

### `GET /health`
Detailed health check with DB status.
```json
{ "status": "healthy", "db": "ok", "ts": "2026-04-04T..." }
```

### `POST /webhook`
Evolution API webhook endpoint. Receives WhatsApp messages.
- Auth: Webhook signature (`apikey` header or HMAC)
- Rate limit: 60 req/min per IP

### `GET /webhook`
Webhook verification.
```json
{ "status": "ok" }
```

---

## Authenticated Endpoints (JWT required)

### Evolution API

#### `POST /evolution/create-instance`
Create a WhatsApp instance.
```json
{ "clinicaId": "uuid", "instanceName": "clinica-abc12345" }
```

#### `GET /evolution/qrcode/:instanceName`
Get QR code to connect WhatsApp.

#### `GET /evolution/status/:instanceName`
Check connection status.

#### `DELETE /evolution/instance/:instanceName`
Delete an instance.

### Onboarding

#### `POST /api/onboarding/clinica`
Create a clinic during onboarding.
```json
{ "nome": "Clínica Saúde", "telefone": "11999999999", "horario_abertura": "08:00", "horario_fechamento": "18:00" }
```

#### `POST /api/onboarding/profissional`
Add a professional.
```json
{ "clinica_id": "uuid", "nome": "Dra. Ana", "especialidade": "Clínico Geral" }
```

#### `POST /api/onboarding/servico`
Add a service.
```json
{ "clinica_id": "uuid", "nome": "Consulta", "duracao_minutos": 30, "preco": 250 }
```

### Export

#### `GET /api/export/agendamentos?desde=2026-01-01&ate=2026-04-04&format=csv`
Export appointments as CSV. Use `format=json` for JSON.

#### `GET /api/export/financeiro?desde=2026-01-01&ate=2026-04-04`
Export financial report as CSV.

---

## Cron Endpoints (API key required)

### `GET /api/notifications/process`
Send 24h reminder notifications. Call every hour.
```bash
curl -H "x-api-key: YOUR_KEY" https://backend/api/notifications/process
```

### `GET /api/cleanup/conversas`
Clean up stale conversations. Call every 6 hours.
```bash
curl -H "x-api-key: YOUR_KEY" https://backend/api/cleanup/conversas
```

---

## Rate Limits

| Endpoint group | Limit |
|---|---|
| Webhook | 60 req/min per IP |
| API routes | 30 req/min per IP |
| Evolution routes | 10 req/min per IP |

---

## Error Responses

All errors follow this format:
```json
{ "error": "Description of error" }
```

| Code | Meaning |
|---|---|
| 400 | Bad request / validation error |
| 401 | Missing or invalid auth token |
| 403 | Forbidden (wrong clinic / no permission) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
| 503 | Service unavailable (DB down) |
