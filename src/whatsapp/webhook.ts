function resolverDataHora(data?: string, horario?: string): string | null {
  if (!horario && !data) return null;

  const hoje = new Date();
  let dataAlvo: Date | null = null;

  if (!data) {
    dataAlvo = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
  } else if (data.match(/^\d{4}-\d{2}-\d{2}$/)) {
    dataAlvo = new Date(data + 'T00:00:00-03:00');
  } else if (data.match(/\d{2}\/\d{2}/)) {
    const match = data.match(/(\d{2})\/(\d{2})/);
    if (match) {
      dataAlvo = new Date(hoje.getFullYear(), Number(match[2]) - 1, Number(match[1]));
    }
  } else if (data.match(/dia\s*(\d{1,2})/i)) {
    const match = data.match(/dia\s*(\d{1,2})/i);
    if (match) {
      const dia = Number(match[1]);
      dataAlvo = new Date(hoje.getFullYear(), hoje.getMonth(), dia);
      if (dataAlvo <= hoje) dataAlvo.setMonth(dataAlvo.getMonth() + 1);
    }
  } else {
    const diasMap: Record<string, number> = {
      'domingo': 0, 'segunda': 1, 'terca': 2, 'terça': 2,
      'quarta': 3, 'quinta': 4, 'sexta': 5, 'sabado': 6, 'sábado': 6,
    };
    const dataLower = data.toLowerCase().replace('-feira', '').trim();
    if (dataLower === 'amanha' || dataLower === 'amanhã') {
      dataAlvo = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
    } else if (dataLower === 'hoje') {
      dataAlvo = hoje;
    } else {
      const diaAlvo = diasMap[dataLower];
      if (diaAlvo !== undefined) {
        dataAlvo = new Date(hoje);
        let diff = diaAlvo - hoje.getDay();
        if (diff <= 0) diff += 7;
        dataAlvo.setDate(hoje.getDate() + diff);
      }
    }
  }

  if (!dataAlvo) return null;

  const ano = dataAlvo.getFullYear();
  const mes = String(dataAlvo.getMonth() + 1).padStart(2, '0');
  const dia = String(dataAlvo.getDate()).padStart(2, '0');

  // Parse horário - aceita "15:30", "8", "8h", "8 da manha", "3 da tarde"
  let h = '09';
  let m = '00';

  if (horario) {
    const fullMatch = horario.match(/(\d{1,2}):(\d{2})/);
    const simpleMatch = horario.match(/(\d{1,2})\s*(?:h|da|$)/i);

    if (fullMatch) {
      h = String(fullMatch[1]).padStart(2, '0');
      m = fullMatch[2];
    } else if (simpleMatch) {
      let hora = Number(simpleMatch[1]);
      if (horario.toLowerCase().includes('tarde') || horario.toLowerCase().includes('noite')) {
        if (hora < 12) hora += 12;
      }
      if (hora < 7) hora += 12;
      h = String(hora).padStart(2, '0');
      m = '00';
    }
  }

  retur
