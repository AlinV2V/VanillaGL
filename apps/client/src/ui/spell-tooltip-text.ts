/** Asset conversion utility. */
export type SpellTooltipEntry = [
  description: string,
  tooltip: string,
  basePoints: number[],
  dieSides: number[],
  amplitudeMs: number[],
  durationMs: number,
];

export type SpellTooltipCorpus = Record<number, SpellTooltipEntry>;

let corpus: SpellTooltipCorpus | null = null;
let loading: Promise<SpellTooltipCorpus> | null = null;

/** Fetch once and cache. Safe to call on every hover. */
export function loadSpellTooltips(): Promise<SpellTooltipCorpus> {
  if (corpus) return Promise.resolve(corpus);
  loading ??= fetch('/spells/spell-tooltips.json')
    .then((response) => {
      if (!response.ok) throw new Error(`spell tooltip corpus ${response.status}`);
      return response.json() as Promise<SpellTooltipCorpus>;
    })
    .then((data) => { corpus = data; return data; })
    .catch(() => { loading = null; return {}; });
  return loading;
}

/** Already-loaded corpus, for synchronous paint paths. */
export const spellTooltipEntry = (spellId: number): SpellTooltipEntry | undefined => corpus?.[spellId];

/** Vanilla writes whole minutes as "N min", everything else as seconds. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  const seconds = ms / 1000;
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? 'min' : 'min'}`;
  }
  return `${Number.isInteger(seconds) ? seconds : +seconds.toFixed(1)} sec`;
}

const effectValue = (entry: SpellTooltipEntry, index: number) => {
  const base = entry[2][index] ?? 0;
  const sides = entry[3][index] ?? 0;
  const low = base + 1;
  if (sides <= 1) return { low, high: low, text: String(low) };
  const high = base + sides;
  return { low, high, text: `${low} to ${high}` };
};

const periodicTotal = (entry: SpellTooltipEntry, index: number) => {
  const perTick = effectValue(entry, index);
  const amplitude = entry[4][index] ?? 0;
  const duration = entry[5] ?? 0;
  if (amplitude <= 0 || duration <= 0) return perTick.text;
  const ticks = Math.max(1, Math.round(duration / amplitude));
  return perTick.low === perTick.high
    ? String(perTick.low * ticks)
    : `${perTick.low * ticks} to ${perTick.high * ticks}`;
};

/**
 * Resolve every token in one Spell.dbc string.
 *
 * `$lsingular:plural;` is handled after the numeric tokens so it can read the digits it follows,
 * which is how the client decides between "1 combo point" and "2 combo points".
 */
export function resolveSpellTokens(text: string, entry: SpellTooltipEntry): string {
  if (!text) return '';
  // The index is optional: a bare `$t` / `$s` means effect 1, which some strings rely on
  // ("Drains 250 mana every $t second."). `?? '1'` is that default.
  let out = text
    .replace(/\$s(\d)?/gi, (_, n?: string) => effectValue(entry, Number(n ?? '1') - 1).text)
    .replace(/\$o(\d)?/gi, (_, n?: string) => periodicTotal(entry, Number(n ?? '1') - 1))
    .replace(/\$t(\d)?/gi, (_, n?: string) => String((entry[4][Number(n ?? '1') - 1] ?? 0) / 1000))
    .replace(/\$d/gi, () => formatDuration(entry[5] ?? 0));

  // $lsingular:plural; — vanilla also spells it $Lsingular:plural;. It pluralises against the count
  // that precedes it.
  out = out.replace(/(\d+)([^$]*)\$l([^:;]*):([^;]*);/gi,
    (_, digits: string, between: string, singular: string, plural: string) =>
      `${digits}${between}${Number(digits) === 1 ? singular : plural}`);
  // Some strings have no count to agree with — either none at all ("charges the nearest
  // $lenemy:enemies;") or one behind a token this engine does not claim, like `$n`. Vanilla reads
  // singular there, and leaving the raw form in the sentence is worse than either choice.
  out = out.replace(/\$l([^:;]*):([^;]*);/gi, (_, singular: string) => singular);

  // Vanilla writes literal \r\n escapes inside some descriptions (Eviscerate's combo table).
  return out.replace(/\\r\\n|\\n/g, '\n').trim();
}

/** The description line as the tooltip shows it, or '' when the spell has no text. */
export function spellDescription(spellId: number): string {
  const entry = spellTooltipEntry(spellId);
  return entry ? resolveSpellTokens(entry[0], entry) : '';
}

/** The secondary aura line ("$s1 damage every $t1 seconds."), or ''. */
export function spellAuraDescription(spellId: number): string {
  const entry = spellTooltipEntry(spellId);
  return entry ? resolveSpellTokens(entry[1], entry) : '';
}
