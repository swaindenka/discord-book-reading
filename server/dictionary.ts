import type { Config } from './config.js';
import type { Database } from './db.js';
import type { DictionaryEntry, DictionaryResult, DictionarySense } from '../shared/types.js';
import { WordNet } from './wordnet.js';
export { normalizeQuery } from '../shared/text.js';

const FOUND_TTL_MS = 30 * 24 * 3600_000;
const MISSING_TTL_MS = 24 * 3600_000;
const MAX_SENSES = 4;
const MAX_DEFINITIONS = 3;

export function oxfordLearnersUrl(word: string) {
  return `https://www.oxfordlearnersdictionaries.com/search/english/?q=${encodeURIComponent(word)}`;
}

/** Wiktionary REST API: definitions are small HTML snippets. */
interface WiktionaryDefinition {
  definition?: string;
  parsedExamples?: { example?: string }[];
  examples?: string[];
}

function stripHtml(html: string) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseWiktionary(data: unknown, word: string): DictionaryEntry | null {
  const english = (data as { en?: { partOfSpeech?: string; definitions?: WiktionaryDefinition[] }[] })?.en ?? [];
  const senses: DictionarySense[] = [];
  for (const group of english) {
    const sense: DictionarySense = { partOfSpeech: (group.partOfSpeech ?? '').toLowerCase(), definitions: [] };
    for (const def of group.definitions ?? []) {
      const text = stripHtml(def.definition ?? '');
      if (!text || sense.definitions.length >= MAX_DEFINITIONS) continue;
      const rawExample = def.parsedExamples?.[0]?.example ?? def.examples?.[0];
      const example = rawExample ? stripHtml(rawExample) : '';
      sense.definitions.push({ text, ...(example ? { example } : {}) });
    }
    if (sense.definitions.length) senses.push(sense);
    if (senses.length >= MAX_SENSES) break;
  }
  if (!senses.length) return null;
  return { word, senses, source: 'wiktionary', sourceLabel: 'Wiktionary' };
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

type Provider = 'oxford' | 'wordnet' | 'wiktionary';

export class Dictionary {
  private inflight = new Map<string, Promise<DictionaryEntry | null>>();
  private usage = new Map<string, number[]>();
  private readonly wordnet = new WordNet();
  /** Tried in order until one knows the word. */
  readonly chain: Provider[];

  constructor(
    private readonly config: Config['dictionary'],
    private readonly db: Database,
  ) {
    const hasOxford = Boolean(config.oxfordAppId && config.oxfordAppKey);
    this.chain =
      config.mode === 'off'
        ? []
        : config.mode === 'offline'
          ? ['wordnet']
          : [...(config.mode === 'auto' && hasOxford ? (['oxford'] as const) : []), 'wordnet', 'wiktionary'];
  }

  /** What the client is told: who answers first, or null when look-ups are off. */
  get provider(): 'oxford' | 'builtin' | null {
    if (!this.chain.length) return null;
    return this.chain[0] === 'oxford' ? 'oxford' : 'builtin';
  }

  /** Loads the built-in dictionary in the background so the first look-up is instant. */
  warmUp() {
    if (this.chain.includes('wordnet')) this.wordnet.load().catch((err) => console.warn('[dictionary] WordNet failed to load', err));
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

  /**
   * Asks each dictionary in turn. An online dictionary that fails or times out is skipped,
   * so the built-in one still answers when the network or a service is down.
   */
  async define(query: string): Promise<DictionaryResult> {
    const result: DictionaryResult = { query, entry: null, oxfordUrl: oxfordLearnersUrl(query) };
    for (const provider of this.chain) {
      try {
        result.entry = await this.lookup(provider, query);
      } catch (err) {
        console.warn(`[dictionary] ${provider}: ${(err as Error).message}`);
      }
      if (result.entry) break;
    }
    return result;
  }

  private lookup(provider: Provider, word: string): Promise<DictionaryEntry | null> {
    if (provider === 'wordnet') return this.wordnet.lookup(word);
    const key = `${provider}:${word}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.cachedLookup(provider, key, word).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async cachedLookup(provider: Provider, key: string, word: string): Promise<DictionaryEntry | null> {
    const cached = await this.db.getCached(key).catch(() => null);
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      if (cached.data && age < FOUND_TTL_MS) return JSON.parse(cached.data) as DictionaryEntry;
      if (!cached.data && age < MISSING_TTL_MS) return null;
    }
    const entry = provider === 'oxford' ? await this.fetchOxford(word) : await this.fetchWiktionary(word);
    await this.db.putCached(key, entry ? JSON.stringify(entry) : null).catch(() => {});
    return entry;
  }

  private async fetchWiktionary(word: string): Promise<DictionaryEntry | null> {
    // Wikimedia asks API clients to identify themselves.
    const headers = { Accept: 'application/json', 'User-Agent': 'ReadingRoom/1.0 (book club reading app)' };
    for (const form of [word, ...WordNet.baseForms(word)]) {
      const res = await fetch(`${this.config.wiktionaryApiBase}/${encodeURIComponent(form.replace(/ /g, '_'))}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`Wiktionary answered ${res.status}`);
      const entry = parseWiktionary(await res.json(), form);
      if (entry) return entry;
    }
    return null;
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
