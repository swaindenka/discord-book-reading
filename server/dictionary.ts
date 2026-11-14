import type { Config } from './config.js';
import type { Database } from './db.js';
import type { DictionaryEntry, DictionaryResult, DictionarySense } from '../shared/types.js';
export { normalizeQuery } from '../shared/text.js';

const FOUND_TTL_MS = 30 * 24 * 3600_000;
const MISSING_TTL_MS = 24 * 3600_000;
const MAX_SENSES = 4;
const MAX_DEFINITIONS = 3;

export function oxfordLearnersUrl(word: string) {
  return `https://www.oxfordlearnersdictionaries.com/search/english/?q=${encodeURIComponent(word)}`;
}

/** Simple fallbacks for inflected forms ("readers" → "reader", "walked" → "walk"). */
function baseForms(word: string): string[] {
  if (word.includes(' ')) return [];
  const forms: string[] = [];
  const add = (w: string) => w.length > 2 && w !== word && !forms.includes(w) && forms.push(w);
  if (word.endsWith('ies')) add(word.slice(0, -3) + 'y');
  if (word.endsWith('es')) add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));
  if (word.endsWith('ied')) add(word.slice(0, -3) + 'y');
  if (word.endsWith('ed')) {
    add(word.slice(0, -2));
    add(word.slice(0, -1));
  }
  if (word.endsWith('ing')) {
    add(word.slice(0, -3));
    add(word.slice(0, -3) + 'e');
  }
  if (word.endsWith('ly')) add(word.slice(0, -2));
  return forms.slice(0, 3);
}

// ---- providers ---------------------------------------------------------------

interface FreeApiEntry {
  word?: string;
  phonetic?: string;
  phonetics?: { text?: string }[];
  meanings?: { partOfSpeech?: string; definitions?: { definition?: string; example?: string }[] }[];
}

function parseFreeApi(data: unknown): DictionaryEntry | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const entries = data as FreeApiEntry[];
  const senses = new Map<string, DictionarySense>();
  for (const entry of entries) {
    for (const meaning of entry.meanings ?? []) {
      const pos = meaning.partOfSpeech ?? '';
      const sense = senses.get(pos) ?? { partOfSpeech: pos, definitions: [] };
      for (const def of meaning.definitions ?? []) {
        if (def.definition && sense.definitions.length < MAX_DEFINITIONS) {
          sense.definitions.push({ text: def.definition, ...(def.example ? { example: def.example } : {}) });
        }
      }
      if (sense.definitions.length) senses.set(pos, sense);
    }
  }
  if (senses.size === 0) return null;
  const first = entries[0];
  const phonetic = first.phonetic ?? entries.flatMap((e) => e.phonetics ?? []).find((p) => p.text)?.text;
  return {
    word: first.word ?? '',
    ...(phonetic ? { phonetic } : {}),
    senses: [...senses.values()].slice(0, MAX_SENSES),
    source: 'free',
    sourceLabel: 'Wiktionary (Free Dictionary API)',
  };
}

interface OxfordSense {
  definitions?: string[];
  shortDefinitions?: string[];
  examples?: { text?: string }[];
  subsenses?: OxfordSense[];
}

interface OxfordResponse {
  results?: {
    word?: string;
    lexicalEntries?: {
      lexicalCategory?: { text?: string };
      pronunciations?: { phoneticSpelling?: string }[];
      entries?: { pronunciations?: { phoneticSpelling?: string }[]; senses?: OxfordSense[] }[];
    }[];
  }[];
}

function parseOxford(data: unknown): DictionaryEntry | null {
  const results = (data as OxfordResponse)?.results ?? [];
  const senses: DictionarySense[] = [];
  let phonetic: string | undefined;
  let word = '';
  for (const result of results) {
    word ||= result.word ?? '';
    for (const lexical of result.lexicalEntries ?? []) {
      const sense: DictionarySense = { partOfSpeech: (lexical.lexicalCategory?.text ?? '').toLowerCase(), definitions: [] };
      phonetic ??= lexical.pronunciations?.find((p) => p.phoneticSpelling)?.phoneticSpelling;
      for (const entry of lexical.entries ?? []) {
        phonetic ??= entry.pronunciations?.find((p) => p.phoneticSpelling)?.phoneticSpelling;
        for (const s of entry.senses ?? []) {
          const text = s.definitions?.[0] ?? s.shortDefinitions?.[0];
          if (text && sense.definitions.length < MAX_DEFINITIONS) {
            const example = s.examples?.find((e) => e.text)?.text;
            sense.definitions.push({ text, ...(example ? { example } : {}) });
          }
        }
      }
      if (sense.definitions.length) senses.push(sense);
    }
  }
  if (senses.length === 0) return null;
  return {
    word,
    ...(phonetic ? { phonetic: `/${phonetic}/` } : {}),
    senses: senses.slice(0, MAX_SENSES),
    source: 'oxford',
    sourceLabel: 'Oxford Dictionaries',
  };
}

export class Dictionary {
  private inflight = new Map<string, Promise<DictionaryEntry | null>>();
  private usage = new Map<string, number[]>();

  constructor(
    private readonly config: Config['dictionary'],
    private readonly db: Database,
  ) {}

  get provider() {
    return this.config.provider;
  }

  /** At most `limit` look-ups per user per minute. */
  allow(userId: string, limit = 40) {
    const now = Date.now();
    const recent = (this.usage.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) return false;
    recent.push(now);
    this.usage.set(userId, recent);
    return true;
  }

  async define(query: string): Promise<DictionaryResult> {
    const result: DictionaryResult = { query, entry: null, oxfordUrl: oxfordLearnersUrl(query) };
    if (!this.config.provider) return result;
    result.entry = await this.lookup(query);
    // Oxford resolves inflected forms itself (lemmas); the free API needs a little help.
    if (!result.entry && this.config.provider === 'free') {
      for (const form of baseForms(query)) {
        result.entry = await this.lookup(form);
        if (result.entry) break;
      }
    }
    return result;
  }

  private lookup(word: string): Promise<DictionaryEntry | null> {
    const key = `${this.config.provider}:${word}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.cachedLookup(key, word).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async cachedLookup(key: string, word: string): Promise<DictionaryEntry | null> {
    const cached = await this.db.getCached(key).catch(() => null);
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      if (cached.data && age < FOUND_TTL_MS) return JSON.parse(cached.data) as DictionaryEntry;
      if (!cached.data && age < MISSING_TTL_MS) return null;
    }
    const entry = this.config.provider === 'oxford' ? await this.fetchOxford(word) : await this.fetchFree(word);
    await this.db.putCached(key, entry ? JSON.stringify(entry) : null).catch(() => {});
    return entry;
  }

  private async fetchFree(word: string): Promise<DictionaryEntry | null> {
    const res = await fetch(`${this.config.freeApiBase}/${encodeURIComponent(word)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Dictionary service answered ${res.status}`);
    return parseFreeApi(await res.json());
  }

  private async fetchOxford(word: string): Promise<DictionaryEntry | null> {
    const headers = { app_id: this.config.oxfordAppId, app_key: this.config.oxfordAppKey, Accept: 'application/json' };
    const lang = this.config.oxfordLanguage;
    const get = (path: string) =>
      fetch(`${this.config.oxfordApiBase}${path}`, { headers, signal: AbortSignal.timeout(8000) });

    const res = await get(
      `/entries/${lang}/${encodeURIComponent(word)}?fields=definitions,examples,pronunciations&strictMatch=false`,
    );
    if (res.ok) return parseOxford(await res.json());
    if (res.status !== 404) throw new Error(`Oxford Dictionaries answered ${res.status}`);

    // Inflected forms ("ran") live under their lemma ("run").
    const lemmas = await get(`/lemmas/${lang}/${encodeURIComponent(word)}`);
    if (!lemmas.ok) return null;
    const data = (await lemmas.json()) as {
      results?: { lexicalEntries?: { inflectionOf?: { id?: string }[] }[] }[];
    };
    const lemma = data.results?.[0]?.lexicalEntries?.[0]?.inflectionOf?.[0]?.id;
    if (!lemma || lemma === word) return null;
    const again = await get(`/entries/${lang}/${encodeURIComponent(lemma)}?fields=definitions,examples,pronunciations&strictMatch=false`);
    return again.ok ? parseOxford(await again.json()) : null;
  }
}
