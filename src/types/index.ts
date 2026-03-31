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

export interface HorarioDisponivel {
  data: string;
  diaSemana: string;
  horarios: string[];
}

export type Intencao =
  | 'agendar' | 'remarcar' | 'cancelar'
  | 'consultar_horarios' | 'saudacao'
  | 'duvida' | 'agradecimento' | 'outro';

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
  etapa: string;
  dadosColetados: Partial<DadosExtraidos>;
  horariosOferecidos?: HorarioDisponivel[];
  historicoMensagens: Mensagem[];
}

export interface Mensagem {
  role: 'user' | 'assistant';
  content: string;
}
