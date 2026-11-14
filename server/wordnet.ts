import { readFile, open, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DictionaryEntry, DictionarySense } from '../shared/types.js';

const require = createRequire(import.meta.url);
const wordnetDir: string = (require('wordnet-db') as { path: string }).path;
const lemmatizer = require('wink-lemmatizer') as {
  noun(word: string): string;
  verb(word: string): string;
  adjective(word: string): string;
};

type Pos = 'noun' | 'verb' | 'adj' | 'adv';
const POS: Pos[] = ['noun', 'verb', 'adj', 'adv'];
const POS_LABEL: Record<Pos, string> = { noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb' };
const MAX_DEFINITIONS = 3;
const MAX_SENSES = 4;

/**
 * Offline English dictionary built on Princeton WordNet 3.1 (~155,000 words and phrases),
 * shipped with the app, so look-ups work instantly and never depend on an outside service.
 * Inflected forms ("ran", "mice", "better") are resolved with wink-lemmatizer.
 */
export class WordNet {
  /** lemma -> synset offsets, per part of speech. */
  private index: Map<Pos, Map<string, number[]>> | null = null;
  private loading: Promise<void> | null = null;
  private files = new Map<Pos, Promise<FileHandle>>();

  /** Loads the word index (about a second, once). */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const index = new Map<Pos, Map<string, number[]>>();
      for (const pos of POS) {
        const map = new Map<string, number[]>();
        const text = await readFile(path.join(wordnetDir, `index.${pos}`), 'utf8');
        for (const line of text.split('\n')) {
          if (!line || line.startsWith(' ')) continue; // licence header lines start with spaces
          const parts = line.trim().split(' ');
          const synsetCount = Number(parts[2]);
          const pointerCount = Number(parts[3]);
          const offsets = parts.slice(6 + pointerCount, 6 + pointerCount + synsetCount).map(Number);
          if (offsets.length) map.set(parts[0], offsets);
        }
        index.set(pos, map);
      }
      this.index = index;
    })();
    return this.loading;
  }

  private file(pos: Pos) {
    let handle = this.files.get(pos);
    if (!handle) {
      handle = open(path.join(wordnetDir, `data.${pos}`), 'r');
      this.files.set(pos, handle);
    }
    return handle;
  }

  /** Reads one synset line and returns its words and gloss. */
  private async synset(pos: Pos, offset: number): Promise<{ definition: string; examples: string[] } | null> {
    const handle = await this.file(pos);
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const bar = line.indexOf(' | ');
    if (bar < 0) return null;
    const gloss = line.slice(bar + 3).trim();
    // Gloss format: definition; "example one"; "example two"
    const quote = gloss.search(/;\s*"/);
    const definition = (quote >= 0 ? gloss.slice(0, quote) : gloss).trim();
    const examples = quote >= 0 ? [...gloss.slice(quote).matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()) : [];
    return definition ? { definition, examples } : null;
  }

  /** Base forms worth trying for each part of speech. */
  private candidates(word: string): { pos: Pos; lemma: string }[] {
    const key = word.toLowerCase().replace(/\s+/g, '_');
    const forms: Record<Pos, string[]> = {
      noun: [key, lemmatizer.noun(key)],
      verb: [key, lemmatizer.verb(key)],
      adj: [key, lemmatizer.adjective(key)],
      adv: [key],
    };
    const out: { pos: Pos; lemma: string }[] = [];
    // Exact forms first (so "running" as a noun comes before the verb "run"), then base forms.
    for (const pass of [0, 1]) {
      for (const pos of POS) {
        const lemma = forms[pos][pass];
        if (lemma && !out.some((c) => c.pos === pos && c.lemma === lemma)) out.push({ pos, lemma });
      }
    }
    return out;
  }

  async lookup(word: string): Promise<DictionaryEntry | null> {
    await this.load();
    const index = this.index!;
    const senses: DictionarySense[] = [];
    let headword: string | null = null;
    const usedPos = new Set<Pos>();
    for (const { pos, lemma } of this.candidates(word)) {
      if (usedPos.has(pos) || senses.length >= MAX_SENSES) continue;
      const offsets = index.get(pos)!.get(lemma);
      if (!offsets) continue;
      usedPos.add(pos);
      headword ??= lemma;
      const sense: DictionarySense = { partOfSpeech: POS_LABEL[pos], definitions: [] };
      for (const offset of offsets.slice(0, MAX_DEFINITIONS)) {
        const synset = await this.synset(pos, offset);
        if (synset) sense.definitions.push({ text: synset.definition, ...(synset.examples[0] ? { example: synset.examples[0] } : {}) });
      }
      if (sense.definitions.length) senses.push(sense);
    }
    if (!senses.length || !headword) return null;
    return {
      word: headword.replace(/_/g, ' '),
      senses,
      source: 'wordnet',
      sourceLabel: 'WordNet (Princeton)',
    };
  }

  /** Base forms for other dictionaries ("ran" → "run"). */
  static baseForms(word: string): string[] {
    const key = word.toLowerCase();
    if (key.includes(' ')) return [];
    return [...new Set([lemmatizer.verb(key), lemmatizer.noun(key), lemmatizer.adjective(key)])].filter((w) => w && w !== key);
  }
}
