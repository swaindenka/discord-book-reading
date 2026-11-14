/** Turns a text selection into something worth looking up: 1–4 words, letters only. */
export function normalizeQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    // Strip punctuation around the selection ("word," or “word”).
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .toLowerCase();
  if (!cleaned || cleaned.length > 40) return null;
  if (!/^\p{L}+(?:['-]\p{L}+)*(?: \p{L}+(?:['-]\p{L}+)*){0,3}$/u.test(cleaned)) return null;
  return cleaned;
}
