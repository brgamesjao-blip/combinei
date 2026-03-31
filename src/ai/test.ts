import * as readline from 'readline';
import { processarMensagem, criarContextoInicial } from './engine';
import { Clinica } from '../types';

// ═══════════════════════════════════════
// Teste interativo do motor de IA
// Roda: npm run test:ai
// ═══════════════════════════════════════

// Clínica de exemplo para testes
const clinicaTeste: Clinica = {
  id: 'clinica-001',
  nome: 'Clínica Saúde Viva',
  telefone: '+5511999999999',
  profissionais: [
    { id: 'prof-1', nome: 'Dra. Ana Silva', especialidade: 'Clínico Geral', servicos: ['srv-1'] },
    { id: 'prof-2', nome: 'Dr. Carlos Souza', especialidade: 'Ortopedista', servicos: ['srv-1', 'srv-2'] },
    { id: 'prof-3', nome: 'Dra. Beatriz Lima', especialidade: 'Dermatologista', servicos: ['srv-1', 'srv-3'] },
  ],
  servicos: [
    { id: 'srv-1', nome: 'Consulta', duracaoMinutos: 30, preco: 250 },
    { id: 'srv-2', nome: 'Retorno', duracaoMinutos: 15 },
    { id: 'srv-3', nome: 'Avaliação', duracaoMinutos: 45, preco: 350 },
  ],
  horarioFuncionamento: {
    segunda: { inicio: '08:00', fim: '18:00' },
    terca: { inicio: '08:00', fim: '18:00' },
    quarta: { inicio: '08:00', fim: '18:00' },
    quinta: { inicio: '08:00', fim: '18:00' },
    sexta: { inicio: '08:00', fim: '17:00' },
    sabado: null,
    domingo: null,
  },
};

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     🤖 Combinei — Teste do Bot       ║');
  console.log('║  Digite como se fosse um paciente     ║');
  console.log('║  "sair" para encerrar                 ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log(`Clínica: ${clinicaTeste.nome}`);
  console.log(`Profissionais: ${clinicaTeste.profissionais.map(p => p.nome).join(', ')}\n`);

  // Criar contexto com horários de exemplo
  let contexto = criarContextoInicial(clinicaTeste);
  contexto.horariosOferecidos = [
    { data: '2026-04-01', diaSemana: 'Terça', horarios: ['09:00', '10:30', '14:00', '15:30'] },
    { data: '2026-04-02', diaSemana: 'Quarta', horarios: ['08:00', '10:00', '14:00', '16:00'] },
    { data: '2026-04-03', diaSemana: 'Quinta', horarios: ['09:30', '11:00', '14:30', '16:30'] },
    { data: '2026-04-06', diaSemana: 'Segunda', horarios: ['08:00', '09:00', '10:00', '15:00'] },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const perguntar = () => {
    rl.question('📱 Paciente: ', async (input) => {
      const mensagem = input.trim();

      if (mensagem.toLowerCase() === 'sair') {
        console.log('\n👋 Encerrando teste.\n');
        rl.close();
        return;
      }

      if (!mensagem) {
        perguntar();
        return;
      }

      try {
        const resultado = await processarMensagem(mensagem, contexto);
        contexto = resultado.contexto;

        console.log(`\n💬 Bot: ${resultado.resposta}`);
        console.log(`   [etapa: ${contexto.etapa} | dados: ${JSON.stringify(contexto.dadosColetados)}]\n`);
      } catch (error) {
        console.error('\n❌ Erro:', error);
      }

      perguntar();
    });
  };

  perguntar();
}

main().catch(console.error);
