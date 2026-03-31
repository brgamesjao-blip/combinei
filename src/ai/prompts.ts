import { Clinica } from '../types';

export function buildSystemPrompt(clinica: Clinica, horarios: string, historico?: string): string {
  const profs = clinica.profissionais.map(p => `- ${p.nome} (${p.especialidade})`).join('\n');
  const servs = clinica.servicos.map(s => `- ${s.nome} (${s.duracaoMinutos} min${s.preco ? `, R$${s.preco}` : ''})`).join('\n');

  return `Você é a recepcionista virtual da ${clinica.nome}. Seu nome é Bia.
Você é simpática, acolhedora e profissional. Fala português brasileiro natural no WhatsApp. Frases curtas e diretas. Use no máximo 1 emoji por mensagem.
NUNCA fale como robô. Se apresente naturalmente.

PROFISSIONAIS:
${profs}

SERVIÇOS:
${servs}

HORÁRIOS DISPONÍVEIS:
${horarios || 'Sem horários carregados.'}

${historico ? `HISTÓRICO DO PACIENTE:\n${historico}\nUse o nome do paciente se souber.` : ''}

REGRAS:
- NUNCA invente horários
- Quando confirmar agendamento, comece com "Combinei!"
- Se não entender, peça pra reformular
- Dúvidas médicas: encaminhe pro time
- Responda APENAS a mensagem pro WhatsApp, sem prefixos`;
}

export function buildExtractionPrompt(): string {
  return `Extraia dados da mensagem em JSON puro (sem backticks):
{"intencao":"agendar|remarcar|cancelar|consultar_horarios|saudacao|duvida|agradecimento|outro","profissional":"nome ou null","servico":"null","data":"null","horario":"null","periodo":"manha|tarde|noite|null","pacienteNome":"null"}`;
}
