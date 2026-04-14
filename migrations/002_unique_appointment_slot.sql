-- ══════════════════════════════════════════════════════════════
-- Combinei v6 — Migration 002
-- Constraint atômica: 1 profissional só pode ter 1 agendamento
-- confirmado por horário. Fecha race condition no criarAgendamento.
-- Execute no Supabase Dashboard → SQL Editor → New Query
-- ══════════════════════════════════════════════════════════════

-- Partial unique index: só aplica a status='confirmado'.
-- Cancelados/realizados podem coexistir no mesmo slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agendamentos_unique_slot
  ON agendamentos (profissional_id, data_hora)
  WHERE status = 'confirmado';

-- Antes de aplicar, se houver duplicatas legadas, rodar:
-- SELECT profissional_id, data_hora, COUNT(*) FROM agendamentos
-- WHERE status='confirmado' GROUP BY 1,2 HAVING COUNT(*) > 1;
-- E resolver manualmente (cancelar duplicatas) antes de criar o índice.
