// ═══════════════════════════════════════
// Tipos do sistema Combinei
// ═══════════════════════════════════════

// ─── Clínica ───
export interface Clinica {
  id: string;
  nome: string;
  telefone: string;
  profissionais: Profissional[];
  servicos: Servico[];
  horarioFuncionamento: HorarioFuncionamento;
}

export interface Profissional {
  id: string;
  nome: string;
  especialidade: string;
  servicos: string[];
}

export interface Servico {
  id: string;
  nome: string;
  duracaoMinutos: number;
  preco?: number;
}

export interface HorarioFuncionamento {
  [dia: string]: { inicio: string; fim: string } | null;
}

// ─── Agendamento ───
export interface Agendamento {
  id: string;
  pacienteNome: string;
  pacienteTelefone: string;
  profissionalId: string;
  servicoId: string;
  dataHora: string;
  duracaoMinutos: number;
  status: 'confirmado' | 'cancelado' | 'remarcado';
  googleCalendarEventId?: string;
}

// ─── Horário Disponível ───
export interface HorarioDisponivel {
  data: string;
  diaSemana: string;
  horarios: string[];
}

// ─── Conversa / IA ───
export type Intencao =
  | 'agendar'
  | 'remarcar'
  | 'cancelar'
  | 'consultar_horarios'
  | 'saudacao'
  | 'duvida'
  | 'agradecimento'
  | 'outro';

export interface DadosExtraidos {
  intencao: Intencao;
  profissional?: string;
  servico?: string;
  data?: string;
  horario?: string;
  periodo?: 'manha' | 'tarde' | 'noite';
  pacienteNome?: string;
}

export interface ContextoConversa {
  clinica: Clinica;
  etapa: EtapaConversa;
  dadosColetados: Partial<DadosExtraidos>;
  horariosOferecidos?: HorarioDisponivel[];
  historicoMensagens: Mensagem[];
}

export type EtapaConversa =
  | 'inicio'
  | 'identificar_intencao'
  | 'coletar_profissional'
  | 'coletar_data'
  | 'coletar_horario'
  | 'confirmar_agendamento'
  | 'agendamento_concluido'
  | 'encaminhar_humano';

export interface Mensagem {
  role: 'user' | 'assistant';
  content: string;
}

// ─── WhatsApp ───
export interface WhatsAppMessage {
  from: string;
  body: string;
  timestamp: number;
  messageId: string;
}
