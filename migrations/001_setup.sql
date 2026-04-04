-- ══════════════════════════════════════════════════════════════
-- Combinei v6 — Supabase Migration
-- Execute no Supabase Dashboard → SQL Editor → New Query
-- ══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ────────── TABLES ──────────

CREATE TABLE IF NOT EXISTS clinicas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  telefone TEXT,
  horario_abertura TEXT DEFAULT '08:00',
  horario_fechamento TEXT DEFAULT '18:00',
  almoco_inicio TEXT DEFAULT '12:00',
  almoco_fim TEXT DEFAULT '13:00',
  dias_atendimento INTEGER[] DEFAULT '{1,2,3,4,5}',  -- 0=dom 1=seg ... 6=sab
  ativa BOOLEAN DEFAULT true,
  phone_number_id TEXT,
  whatsapp_token TEXT,
  bot_nome TEXT DEFAULT 'Bia',
  msg_saudacao TEXT,
  msg_confirmacao TEXT,
  msg_cancelamento TEXT,
  msg_fora_horario TEXT,
  msg_sem_horario TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profissionais (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinica_id UUID NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  especialidade TEXT NOT NULL,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS servicos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinica_id UUID NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  duracao_minutos INTEGER DEFAULT 30,
  preco NUMERIC(10,2),
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinica_id UUID NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
  profissional_id UUID REFERENCES profissionais(id),
  paciente_nome TEXT,
  paciente_telefone TEXT,
  data_hora TIMESTAMPTZ NOT NULL,
  duracao_minutos INTEGER DEFAULT 30,
  status TEXT DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'cancelado', 'realizado')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinica_id UUID NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
  paciente_telefone TEXT NOT NULL,
  etapa TEXT DEFAULT 'inicio',
  dados_coletados JSONB DEFAULT '{}',
  historico_mensagens JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (clinica_id, paciente_telefone)
);

CREATE TABLE IF NOT EXISTS folgas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinica_id UUID NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
  profissional_id UUID NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  motivo TEXT DEFAULT 'Folga',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (clinica_id, profissional_id, data)
);

CREATE TABLE IF NOT EXISTS notificacoes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinica_id UUID NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
  agendamento_id UUID REFERENCES agendamentos(id),
  tipo TEXT NOT NULL,
  telefone TEXT,
  mensagem TEXT,
  enviado BOOLEAN DEFAULT false,
  enviado_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usuarios_clinica (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  clinica_id UUID NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  role TEXT DEFAULT 'recepcionista' CHECK (role IN ('admin', 'medico', 'recepcionista')),
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  ativo BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ────────── If upgrading from v5, add new column ──────────
DO $$ BEGIN
  ALTER TABLE clinicas ADD COLUMN IF NOT EXISTS dias_atendimento INTEGER[] DEFAULT '{1,2,3,4,5}';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ────────── INDEXES ──────────
CREATE INDEX IF NOT EXISTS idx_clinicas_user ON clinicas(user_id);
CREATE INDEX IF NOT EXISTS idx_clinicas_phone ON clinicas(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_profissionais_clinica ON profissionais(clinica_id);
CREATE INDEX IF NOT EXISTS idx_servicos_clinica ON servicos(clinica_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_clinica ON agendamentos(clinica_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_status ON agendamentos(clinica_id, status);
CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(clinica_id, data_hora);
CREATE INDEX IF NOT EXISTS idx_agendamentos_paciente ON agendamentos(clinica_id, paciente_telefone);
CREATE INDEX IF NOT EXISTS idx_agendamentos_prof ON agendamentos(profissional_id, data_hora);
CREATE INDEX IF NOT EXISTS idx_conversas_clinica ON conversas(clinica_id, paciente_telefone);
CREATE INDEX IF NOT EXISTS idx_folgas_clinica ON folgas(clinica_id, data);
CREATE INDEX IF NOT EXISTS idx_notificacoes_agendamento ON notificacoes(agendamento_id, tipo);
CREATE INDEX IF NOT EXISTS idx_notificacoes_tipo ON notificacoes(clinica_id, tipo, created_at);
CREATE INDEX IF NOT EXISTS idx_usuarios_clinica ON usuarios_clinica(clinica_id);

-- ────────── Realtime: enable for dashboard live updates ──────────
ALTER PUBLICATION supabase_realtime ADD TABLE agendamentos;
ALTER PUBLICATION supabase_realtime ADD TABLE notificacoes;
ALTER PUBLICATION supabase_realtime ADD TABLE conversas;

-- ────────── ROW LEVEL SECURITY ──────────
ALTER TABLE clinicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE profissionais ENABLE ROW LEVEL SECURITY;
ALTER TABLE servicos ENABLE ROW LEVEL SECURITY;
ALTER TABLE agendamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversas ENABLE ROW LEVEL SECURITY;
ALTER TABLE folgas ENABLE ROW LEVEL SECURITY;
ALTER TABLE notificacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios_clinica ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION get_user_clinica_ids()
RETURNS SETOF UUID LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id FROM clinicas WHERE user_id = auth.uid()
  UNION
  SELECT clinica_id FROM usuarios_clinica WHERE user_id = auth.uid() AND ativo = true
$$;

-- CLINICAS
DROP POLICY IF EXISTS "clinicas_select" ON clinicas;
DROP POLICY IF EXISTS "clinicas_insert" ON clinicas;
DROP POLICY IF EXISTS "clinicas_update" ON clinicas;
DROP POLICY IF EXISTS "clinicas_delete" ON clinicas;
CREATE POLICY "clinicas_select" ON clinicas FOR SELECT USING (user_id = auth.uid() OR id IN (SELECT clinica_id FROM usuarios_clinica WHERE user_id = auth.uid() AND ativo = true));
CREATE POLICY "clinicas_insert" ON clinicas FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "clinicas_update" ON clinicas FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "clinicas_delete" ON clinicas FOR DELETE USING (user_id = auth.uid());

-- PROFISSIONAIS
DROP POLICY IF EXISTS "profissionais_select" ON profissionais;
DROP POLICY IF EXISTS "profissionais_insert" ON profissionais;
DROP POLICY IF EXISTS "profissionais_update" ON profissionais;
DROP POLICY IF EXISTS "profissionais_delete" ON profissionais;
CREATE POLICY "profissionais_select" ON profissionais FOR SELECT USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "profissionais_insert" ON profissionais FOR INSERT WITH CHECK (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "profissionais_update" ON profissionais FOR UPDATE USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "profissionais_delete" ON profissionais FOR DELETE USING (clinica_id IN (SELECT get_user_clinica_ids()));

-- SERVICOS
DROP POLICY IF EXISTS "servicos_select" ON servicos;
DROP POLICY IF EXISTS "servicos_insert" ON servicos;
DROP POLICY IF EXISTS "servicos_update" ON servicos;
DROP POLICY IF EXISTS "servicos_delete" ON servicos;
CREATE POLICY "servicos_select" ON servicos FOR SELECT USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "servicos_insert" ON servicos FOR INSERT WITH CHECK (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "servicos_update" ON servicos FOR UPDATE USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "servicos_delete" ON servicos FOR DELETE USING (clinica_id IN (SELECT get_user_clinica_ids()));

-- AGENDAMENTOS
DROP POLICY IF EXISTS "agendamentos_select" ON agendamentos;
DROP POLICY IF EXISTS "agendamentos_insert" ON agendamentos;
DROP POLICY IF EXISTS "agendamentos_update" ON agendamentos;
DROP POLICY IF EXISTS "agendamentos_delete" ON agendamentos;
CREATE POLICY "agendamentos_select" ON agendamentos FOR SELECT USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "agendamentos_insert" ON agendamentos FOR INSERT WITH CHECK (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "agendamentos_update" ON agendamentos FOR UPDATE USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "agendamentos_delete" ON agendamentos FOR DELETE USING (clinica_id IN (SELECT get_user_clinica_ids()));

-- CONVERSAS
DROP POLICY IF EXISTS "conversas_select" ON conversas;
DROP POLICY IF EXISTS "conversas_insert" ON conversas;
DROP POLICY IF EXISTS "conversas_update" ON conversas;
DROP POLICY IF EXISTS "conversas_delete" ON conversas;
CREATE POLICY "conversas_select" ON conversas FOR SELECT USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "conversas_insert" ON conversas FOR INSERT WITH CHECK (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "conversas_update" ON conversas FOR UPDATE USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "conversas_delete" ON conversas FOR DELETE USING (clinica_id IN (SELECT get_user_clinica_ids()));

-- FOLGAS
DROP POLICY IF EXISTS "folgas_select" ON folgas;
DROP POLICY IF EXISTS "folgas_insert" ON folgas;
DROP POLICY IF EXISTS "folgas_delete" ON folgas;
CREATE POLICY "folgas_select" ON folgas FOR SELECT USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "folgas_insert" ON folgas FOR INSERT WITH CHECK (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "folgas_delete" ON folgas FOR DELETE USING (clinica_id IN (SELECT get_user_clinica_ids()));

-- NOTIFICACOES
DROP POLICY IF EXISTS "notificacoes_select" ON notificacoes;
DROP POLICY IF EXISTS "notificacoes_insert" ON notificacoes;
CREATE POLICY "notificacoes_select" ON notificacoes FOR SELECT USING (clinica_id IN (SELECT get_user_clinica_ids()));
CREATE POLICY "notificacoes_insert" ON notificacoes FOR INSERT WITH CHECK (clinica_id IN (SELECT get_user_clinica_ids()));

-- USUARIOS_CLINICA
DROP POLICY IF EXISTS "usuarios_clinica_select" ON usuarios_clinica;
DROP POLICY IF EXISTS "usuarios_clinica_insert" ON usuarios_clinica;
DROP POLICY IF EXISTS "usuarios_clinica_update" ON usuarios_clinica;
DROP POLICY IF EXISTS "usuarios_clinica_delete" ON usuarios_clinica;
CREATE POLICY "usuarios_clinica_select" ON usuarios_clinica FOR SELECT USING (clinica_id IN (SELECT get_user_clinica_ids()) OR email = (SELECT email FROM auth.users WHERE id = auth.uid()));
CREATE POLICY "usuarios_clinica_insert" ON usuarios_clinica FOR INSERT WITH CHECK (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()));
CREATE POLICY "usuarios_clinica_update" ON usuarios_clinica FOR UPDATE USING (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()));
CREATE POLICY "usuarios_clinica_delete" ON usuarios_clinica FOR DELETE USING (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()));

-- ══════════════════════════════════════════════════════════════
-- PRONTO! RLS ativo. Realtime habilitado para agendamentos,
-- notificacoes e conversas (dashboard recebe updates ao vivo).
-- ══════════════════════════════════════════════════════════════
