/** Matchers fuzzy pra entidades da clínica (profissionais, etc). */

export interface MatchResult<T> {
  matched: T | null;
  ambiguous: boolean;
  candidates: T[];
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function stripTitulo(s: string): string {
  return s.replace(/^(doutora?|dra?\.?|doutor|dr\.?)\s*/i, '').trim();
}

/**
 * Faz match em tiers: exato → substring → palavras.
 * Retorna ambiguous=true se múltiplos profissionais batem no mesmo tier
 * (ex: query "joão" e clínica tem "Dr. João Silva" e "Dr. João Pereira").
 */
export function matchProfissional<T extends { nome: string }>(
  query: string | undefined | null,
  profissionais: T[]
): MatchResult<T> {
  if (!query || profissionais.length === 0) {
    return { matched: null, ambiguous: false, candidates: [] };
  }
  const q = stripTitulo(normalize(query));
  if (!q) return { matched: null, ambiguous: false, candidates: [] };

  const normProfs = profissionais.map(p => ({ p, np: stripTitulo(normalize(p.nome)) }));

  // Tier 1: exact match
  const exact = normProfs.filter(({ np }) => np === q);
  if (exact.length === 1) return { matched: exact[0].p, ambiguous: false, candidates: [exact[0].p] };
  if (exact.length > 1) return { matched: null, ambiguous: true, candidates: exact.map(e => e.p) };

  // Tier 2: substring (query ⊂ nome OR nome ⊂ query)
  const sub = normProfs.filter(({ np }) => np.includes(q) || q.includes(np));
  if (sub.length === 1) return { matched: sub[0].p, ambiguous: false, candidates: [sub[0].p] };
  if (sub.length > 1) return { matched: null, ambiguous: true, candidates: sub.map(s => s.p) };

  // Tier 3: word-by-word (toda palavra >2 chars da query precisa aparecer no nome)
  const qWords = q.split(/\s+/).filter(w => w.length > 2);
  if (qWords.length === 0) return { matched: null, ambiguous: false, candidates: [] };
  const word = normProfs.filter(({ np }) => qWords.every(w => np.includes(w)));
  if (word.length === 1) return { matched: word[0].p, ambiguous: false, candidates: [word[0].p] };
  if (word.length > 1) return { matched: null, ambiguous: true, candidates: word.map(w => w.p) };

  return { matched: null, ambiguous: false, candidates: [] };
}

/** Formata lista de profissionais pra mensagem de desambiguação. */
export function formatProfList(profs: { nome: string }[]): string {
  if (profs.length === 0) return '';
  if (profs.length === 1) return profs[0].nome;
  if (profs.length === 2) return `${profs[0].nome} ou ${profs[1].nome}`;
  return profs.slice(0, -1).map(p => p.nome).join(', ') + ' ou ' + profs[profs.length - 1].nome;
}
