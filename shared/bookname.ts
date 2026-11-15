// Turns messy e-book file names (and metadata) into a clean title and author.
//
// Shadow-library downloads use names like
//   "A Man Called Ove A Novel -- Fredrik Backman -- Atria Books, 2014 -- 9781476738024 -- 064e81…2acd -- Anna's Archive.pdf"
//   "The Hobbit (J.R.R. Tolkien) (z-lib.org).epub"
// and we only want "A Man Called Ove" by "Fredrik Backman".

const SITE_MARKERS = [
  /anna['’`]?s[\s_]+archive/i,
  /z-?lib(rary)?(\.org|\.is|\.se)?/i,
  /\blib[\s.-]?gen\b/i,
  /\bpdf ?drive\b/i,
  /\boceanofpdf\b/i,
  /\bebook ?(library|hunter)\b/i,
  /^www\.|\.(com|org|net|io|se|ru)$/i,
];

/** A segment that is clearly not part of a title: hashes, ISBNs, site names, bare years. */
export function isJunkSegment(segment: string): boolean {
  const s = segment.trim();
  if (!s) return true;
  // Content hashes (also when cut short): hex with both digits and letters.
  if (/^[0-9a-f]{8,}$/i.test(s) && /\d/.test(s) && /[a-f]/i.test(s)) return true;
  // ISBNs and lists of them.
  if (/^(isbn[:\s]*)?[\dxX][\d\sxX,;:-]{8,}$/i.test(s)) return true;
  if (/^\d{4}$/.test(s)) return true;
  return SITE_MARKERS.some((re) => re.test(s));
}

/** Looks like a person's name list ("Fredrik Backman", "Tolkien, J. R. R.; Christopher Tolkien"). */
function looksLikeAuthor(segment: string) {
  const s = segment.trim();
  return s.length >= 3 && s.length <= 80 && /\p{L}/u.test(s) && !/\d/.test(s) && (s.match(/[,;&]/g) ?? []).length <= 4;
}

function tidy(text: string) {
  return text
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:,.]+|[\s\-–—:,]+$/g, '')
    .trim();
}

/** Removes "(z-lib.org)", "[Anna's Archive]", "(2014)" and similar from a title. */
function stripJunkBrackets(text: string) {
  return text.replace(/\s*[([{]([^()[\]{}]*)[)\]}]/g, (match, inner: string) => (isJunkSegment(inner) ? '' : match));
}

/** Drops a trailing generic subtitle ("A Novel") that file names glue onto the title. */
function stripGenericSubtitle(title: string) {
  return title.replace(/[\s:–—-]+an? (novel|memoir|thriller|novella)$/i, '').trim() || title;
}

export interface BookName {
  title: string;
  author: string | null;
}

/** Best-effort title and author from a file name (with or without extension). */
export function parseBookFilename(filename: string): BookName {
  let base = filename.replace(/^.*[\\/]/, '').replace(/\.(pdf|epub|txt|md|markdown|cbz|mobi|azw3?|prc)$/i, '');
  // "A.Man.Called.Ove" style names.
  if (!base.includes(' ') && (base.match(/\./g) ?? []).length >= 2) base = base.replace(/\./g, ' ');
  base = stripJunkBrackets(tidy(base));

  const segments = base
    .split(/\s+-{2,}\s+|\s+[–—]\s+|\s*\|\s*/)
    .map(tidy)
    .filter((s) => !isJunkSegment(s));

  const title = stripGenericSubtitle(tidy(segments[0] ?? '')) || tidy(base) || 'Untitled book';
  const author = segments[1] && looksLikeAuthor(segments[1]) ? tidy(segments[1]) : null;
  return { title, author };
}

/** True when a stored name still looks like a raw download file name. */
export function looksLikeRawFilename(name: string) {
  return name
    .split(/\s+-{2,}\s+|\s+[–—]\s+/)
    .slice(1)
    .some((s) => isJunkSegment(s));
}

/** Whether embedded metadata (PDF info, EPUB OPF) is usable as a title. */
export function isUsableMetadataTitle(title: string | null | undefined): title is string {
  if (!title) return false;
  const t = title.trim();
  if (t.length < 2 || t.length > 200) return false;
  if (/^(untitled|unknown|microsoft word|document|title|book|ebook|pdf)\b/i.test(t)) return false;
  if (/\.(docx?|pdf|epub|indd|rtf|odt|tex|qxd)$/i.test(t)) return false;
  if (/^[\d\s_.-]+$/.test(t)) return false;
  return !isJunkSegment(t);
}

/** Cleans a title from metadata or user input without changing a deliberate name. */
export function cleanTitle(title: string) {
  return stripJunkBrackets(tidy(title)) || tidy(title);
}
