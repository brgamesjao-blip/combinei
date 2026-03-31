// ═══════════════════════════════════════
// Tipos do sistema Combinei
// ═══════════════════════════════════════

// ─── Clínica ───
export interface Clinica {
  id: string;
  nome: string;
  telefone: string; // número do WhatsApp
  profissionais: Profissional[];
  servicos: Servico[];
  horarioFuncionamento: HorarioFuncionamento;
}

export interface Profissional {
  id: string;
  nome: string;
  especialidade: string;
  servicos: string[]; // IDs dos serviços que atende
}

export interface Servico {
  id: string;
  nome: string;
  duracaoMinutos: number;
  preco?: number;
}

export interface HorarioFuncionamento {
  [dia: string]: { inicio: string; fim: string } | null; // null = fechado
}

// ─── Agendamento ───
export interface Agendamento {
  id: string;
  pacienteNome: string;
  pacienteTelefone: string;
  profissionalId: string;
  servicoId: string;
  dataHora: string; // ISO 8601
  duracaoMinutos: number;
  status: 'confirmado' | 'cancelado' | 'remarcado';
  googleCalendarEventId?: string;
}

// ─── Horário Disponível ───
export interface HorarioDisponivel {
  data: string;       // "2026-04-01"
  diaSemana: string;  // "Terça"
  horarios: string[]; // ["14:00", "15:30", "16:00"]
}

// ─── Conversa / IA ───
export type Intencao =
  | 'agendar'
  | 'remarcar'
  | 'cancelar'
  | 'consultar_horarios'
  | 'saudacao'
  | 'duvida'
  | 'outro';

export interface DadosExtraidos {
  intencao: Intencao;
  profissional?: string;    // nome ou parte do nome
  servico?: string;         // nome do serviço
  data?: string;            // "terça", "amanhã", "01/04"
  horario?: string;         // "15:30", "à tarde"
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
  from: string;        // número do remetente
  body: string;        // conteúdo da mensagem
  timestamp: number;
  messageId: string;
}
