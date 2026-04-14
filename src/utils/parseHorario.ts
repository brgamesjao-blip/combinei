/**
 * Parser de horário em PT-BR. Aceita formato dígito (14:30, 14h30, 14h),
 * extenso ("duas e meia", "treze horas") e termos especiais (meio dia, meia noite).
 *
 * Retorna { h: "HH", m: "MM" } ou null se não conseguir parsear.
 *
 * Regras de período (AM/PM):
 *  - "manhã" → mantém hora literal
 *  - "tarde"/"noite" → bump para PM se hr < 12
 *  - sem qualificador → hr <= 6 vira PM (16h pra "às 4"), senão literal
 */

const NUM_PT: Record<string, number> = {
  uma: 1, um: 1, duas: 2, dois: 2, tres: 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
  treze: 13, catorze: 14, quatorze: 14, quinze: 15,
  dezesseis: 16, dezasseis: 16, dezessete: 17, dezassete: 17,
  dezoito: 18, dezenove: 19, dezanove: 19, vinte: 20,
};

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function extractHour(s: string): number | null {
  // HH:MM ou HHhMM ou HHh
  const colon = s.match(/(\d{1,2}):(\d{2})/);
  if (colon) return +colon[1];
  const hSuffix = s.match(/(\d{1,2})h/);
  if (hSuffix) return +hSuffix[1];
  // Dígito isolado
  const digit = s.match(/\b(\d{1,2})\b/);
  if (digit) return +digit[1];
  // "vinte e X" → 21..23
  const compose = s.match(/\bvinte\s+e\s+(uma|um|duas|dois|tres)\b/);
  if (compose) return 20 + (NUM_PT[compose[1]] || 0);
  // Número por extenso
  for (const [word, n] of Object.entries(NUM_PT)) {
    if (new RegExp(`\\b${word}\\b`).test(s)) return n;
  }
  return null;
}

function extractMinute(s: string): number {
  // HH:MM
  const colon = s.match(/\d{1,2}:(\d{2})/);
  if (colon) return +colon[1];
  // HHhMM (14h30)
  const h = s.match(/\d{1,2}h(\d{2})/);
  if (h) return +h[1];
  // "e quarenta e cinco" / "e 45"
  if (/\be\s+(quarenta\s+e\s+cinco|45)\b/.test(s)) return 45;
  // "e quinze" / "e 15"
  if (/\be\s+(quinze|15)\b/.test(s)) return 15;
  // "e meia" / "e trinta" / "e 30" — só conta se vier após "e"
  if (/\be\s+(meia|trinta|30)\b/.test(s)) return 30;
  // "meia" sozinho (ex: "duas e meia") — captura só se não for "meia noite"
  if (/\bmeia\b/.test(s) && !/meia[\s-]?noite/.test(s)) return 30;
  return 0;
}

function applyPeriod(hr: number, s: string): number {
  if (/\b(tarde|noite)\b/.test(s)) {
    return hr < 12 ? hr + 12 : hr;
  }
  if (/\bmanha\b/.test(s)) {
    // "12 da manhã" → meia-noite (00)
    if (hr === 12) return 0;
    return hr;
  }
  // Sem qualificador: paciente diz "às 4" → assume tarde (16h)
  if (hr <= 6) return hr + 12;
  return hr;
}

export function parseHorario(input: string | undefined | null): { h: string; m: string } | null {
  if (!input) return null;
  const s = normalize(input);
  if (!s) return null;

  // Casos especiais
  if (/meio[\s-]?dia/.test(s)) {
    const m = extractMinute(s);
    return { h: '12', m: String(m).padStart(2, '0') };
  }
  if (/meia[\s-]?noite/.test(s)) {
    // "meia noite e meia" → 00:30
    const half = /meia[\s-]?noite\s+e\s+(meia|trinta|30)/.test(s);
    return { h: '00', m: half ? '30' : '00' };
  }

  let hr = extractHour(s);
  if (hr === null || hr < 0 || hr > 23) return null;

  const min = extractMinute(s);
  if (min < 0 || min > 59) return null;

  hr = applyPeriod(hr, s);
  if (hr > 23) return null;

  return { h: String(hr).padStart(2, '0'), m: String(min).padStart(2, '0') };
}
