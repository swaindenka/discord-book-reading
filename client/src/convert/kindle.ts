// Converts Kindle books (MOBI, AZW, AZW3/KF8, PRC) to EPUB in the browser before upload.
//
// The Kindle container is parsed by foliate-js (MIT). Each section becomes an XHTML chapter,
// pictures, stylesheets and fonts become files, Kindle-internal links and the table of
// contents are rewritten to chapter#anchor links. The result is an ordinary EPUB, so the
// room reads it with the EPUB reader: synced pages, highlights and the dictionary all work.
import JSZip from 'jszip';
import type { MobiBook, MobiTocItem } from 'foliate-js/mobi.js';

export const KINDLE_EXTENSIONS = ['.mobi', '.azw3', '.azw', '.prc'];

export function isKindleFile(name: string) {
  const lower = name.toLowerCase();
  return KINDLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export class ConversionError extends Error {}

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XML_NAME = /^[A-Za-z_][\w.-]*$/;
/** Kindle-only attributes that mean nothing in an EPUB. */
const KINDLE_ATTRIBUTES = new Set(['filepos', 'recindex', 'mediarecindex', 'aid']);
/** MOBI 6 has no stylesheets; this mimics a Kindle's defaults. */
const MOBI6_CSS = `img { max-width: 100%; height: auto; }
p { margin: 0.3em 0; }
`;

/** Rejects files a browser can't convert: not a Kindle book, or DRM-protected. */
async function checkHeader(file: Blob) {
  const head = new Uint8Array(await file.slice(0, 86).arrayBuffer());
  const magic = String.fromCharCode(...head.slice(60, 68));
  if (magic !== 'BOOKMOBI') throw new ConversionError("This doesn't look like a Kindle book (MOBI or AZW3).");
  const record0 = new DataView(head.buffer).getUint32(78);
  const palmdoc = new DataView(await file.slice(record0, record0 + 16).arrayBuffer());
  if (palmdoc.byteLength >= 14 && palmdoc.getUint16(12) !== 0) {
    throw new ConversionError('This Kindle book is DRM-protected, so it can only be opened on a Kindle.');
  }
}

/** Guesses a file's type from its first bytes (Kindle resources carry no type). */
function sniff(bytes: Uint8Array): { mime: string; ext: string } {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes[0] === 0x89 && text(1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (text(0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (text(0, 2) === 'BM') return { mime: 'image/bmp', ext: 'bmp' };
  if (text(0, 4) === 'wOFF') return { mime: 'font/woff', ext: 'woff' };
  if (text(0, 4) === 'wOF2') return { mime: 'font/woff2', ext: 'woff2' };
  if (text(0, 4) === 'OTTO') return { mime: 'font/otf', ext: 'otf' };
  if ((bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || text(0, 4) === 'true') {
    return { mime: 'font/ttf', ext: 'ttf' };
  }
  if (/<svg[\s>]/.test(new TextDecoder().decode(bytes.slice(0, 1024)))) return { mime: 'image/svg+xml', ext: 'svg' };
  return { mime: 'application/octet-stream', ext: 'bin' };
}

const escapeXml = (value: string) =>
  value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

interface Resource {
  name: string;
  mime: string;
  data: Uint8Array | string;
  cover?: boolean;
}

/** Collects the pictures, stylesheets and fonts the book's sections point to (as blob: URLs). */
class Resources {
  readonly items: Resource[] = [];
  private byUrl = new Map<string, Promise<string>>();
  private count = 0;

  /** Stores a blob: URL as a file in res/ and returns its file name. */
  add(url: string): Promise<string> {
    let name = this.byUrl.get(url);
    if (!name) {
      name = this.load(url);
      this.byUrl.set(url, name);
    }
    return name;
  }

  private async load(url: string) {
    const blob = await (await fetch(url)).blob();
    const index = ++this.count;
    if (blob.type === 'text/css') {
      const name = `s${index}.css`;
      const item: Resource = { name, mime: 'text/css', data: '' };
      this.items.push(item);
      item.data = await this.rewriteCss(await blob.text(), '');
      return name;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = sniff(bytes);
    const name = `r${index}.${type.ext}`;
    this.items.push({ name, mime: type.mime, data: bytes });
    return name;
  }

  addCover(bytes: Uint8Array) {
    const type = sniff(bytes);
    if (!type.mime.startsWith('image/')) return;
    this.items.push({ name: `cover.${type.ext}`, mime: type.mime, data: bytes, cover: true });
  }

  /** Points url(blob:…) references in CSS at the stored files. */
  async rewriteCss(css: string, prefix: string) {
    const urls = [...new Set(Array.from(css.matchAll(/url\(\s*["']?(blob:[^"')\s]+)["']?\s*\)/g), (m) => m[1]))];
    for (const url of urls) {
      try {
        const name = await this.add(url);
        css = css.split(url).join(prefix + name);
      } catch {
        /* missing resource: leave the reference broken rather than fail the book */
      }
    }
    return css;
  }
}

/** Removes markup an XHTML parser would reject: Kindle tags (mbp:…), odd attribute names, scripts. */
function sanitize(root: Element) {
  // <guide> is MOBI 6 bookkeeping that would otherwise show up in the text.
  for (const el of Array.from(root.querySelectorAll('script, iframe, object, embed, form, guide'))) el.remove();
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) walk(child);
    if (el.namespaceURI === XHTML_NS && !XML_NAME.test(el.localName)) {
      el.replaceWith(...Array.from(el.childNodes));
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const keep = attr.namespaceURI ? true : XML_NAME.test(attr.name) && !KINDLE_ATTRIBUTES.has(attr.name);
      if (!keep || /^on/i.test(attr.name)) el.removeAttributeNode(attr);
    }
  };
  walk(root);
}

interface Chapter {
  index: number;
  file: string;
  doc: Document;
}

async function loadChapter(book: MobiBook, index: number, resources: Resources, mobi6: boolean): Promise<Chapter | null> {
  const section = book.sections[index];
  if (!section?.load || section.linear === 'no') return null;
  const url = await section.load();
  const blob = await (await fetch(url)).blob();
  const source = await blob.text();
  const parser = new DOMParser();
  let doc = parser.parseFromString(source, blob.type === 'application/xhtml+xml' ? 'application/xhtml+xml' : 'text/html');
  if (doc.querySelector('parsererror')) doc = parser.parseFromString(source, 'text/html');

  // Pictures, stylesheets and fonts.
  const relink = async (el: Element, attr: string, ns: string | null = null) => {
    const value = ns ? el.getAttributeNS(ns, attr) : el.getAttribute(attr);
    if (!value?.startsWith('blob:')) return;
    try {
      const name = `../res/${await resources.add(value)}`;
      if (ns) el.setAttributeNS(ns, attr, name);
      else el.setAttribute(attr, name);
    } catch {
      el.removeAttribute(attr);
    }
  };
  for (const el of Array.from(doc.querySelectorAll('[src]'))) await relink(el, 'src');
  for (const el of Array.from(doc.querySelectorAll('[poster]'))) await relink(el, 'poster');
  for (const el of Array.from(doc.querySelectorAll('link[href]'))) await relink(el, 'href');
  for (const el of Array.from(doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image'))) {
    await relink(el, 'href', 'http://www.w3.org/1999/xlink');
    await relink(el, 'href');
  }
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = await resources.rewriteCss(style.textContent ?? '', '../res/');
  }
  for (const el of Array.from(doc.querySelectorAll('[style*="blob:"]'))) {
    el.setAttribute('style', await resources.rewriteCss(el.getAttribute('style') ?? '', '../res/'));
  }

  // Keep only stylesheets in <head>; the title and charset are written fresh.
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElementNS(XHTML_NS, 'head'), doc.body);
  for (const el of Array.from(head.children)) {
    const keep = el.localName === 'style' || (el.localName === 'link' && /stylesheet/i.test(el.getAttribute('rel') ?? ''));
    if (!keep) el.remove();
  }
  if (mobi6) {
    const link = doc.createElementNS(XHTML_NS, 'link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('type', 'text/css');
    link.setAttribute('href', '../res/mobi.css');
    head.prepend(link);
  }
  const title = doc.createElementNS(XHTML_NS, 'title');
  title.textContent = book.metadata.title || 'Chapter';
  head.prepend(title);
  return { index, file: `c${index}.xhtml`, doc };
}

/** Rewrites Kindle-internal links (filepos:…, kindle:pos:…) to chapter#anchor links. */
async function resolveLink(book: MobiBook, href: string, chapters: Map<number, Chapter>, counter: { n: number }) {
  try {
    const target = await book.resolveHref(href);
    const chapter = target && chapters.get(target.index);
    if (!target || !chapter) return null;
    let el: Element | null = null;
    try {
      el = target.anchor(chapter.doc);
    } catch {
      el = null;
    }
    if (!el || el === chapter.doc.body || el === chapter.doc.documentElement) return { chapter, fragment: '' };
    if (!el.id) el.id = `k${++counter.n}`;
    return { chapter, fragment: `#${el.id}` };
  } catch {
    return null;
  }
}

function serialize(chapter: Chapter): string {
  const { doc } = chapter;
  sanitize(doc.documentElement);
  const html = new XMLSerializer().serializeToString(doc.documentElement);
  const out = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n${html}`;
  // Make sure the chapter is well-formed XHTML; if not, keep its text.
  const check = new DOMParser().parseFromString(out, 'application/xhtml+xml');
  if (!check.querySelector('parsererror')) return out;
  const paragraphs = (doc.body?.innerText ?? doc.body?.textContent ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeXml(line)}</p>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="${XHTML_NS}"><head><title>${escapeXml(
    doc.title || 'Chapter',
  )}</title></head><body>${paragraphs}</body></html>`;
}

interface NavItem {
  label: string;
  href: string;
  children: NavItem[];
}

const navList = (items: NavItem[]): string =>
  `<ol>${items
    .map(
      (item) =>
        `<li><a href="${escapeXml(item.href)}">${escapeXml(item.label)}</a>${item.children.length ? navList(item.children) : ''}</li>`,
    )
    .join('')}</ol>`;

/** Converts a Kindle book to an EPUB file with the same base name. */
export async function convertKindleToEpub(file: File, onProgress?: (fraction: number) => void): Promise<File> {
  await checkHeader(file);
  const [{ MOBI }, { unzlibSync }] = await Promise.all([import('foliate-js/mobi.js'), import('foliate-js/vendor/fflate.js')]);
  let book: MobiBook;
  try {
    book = await new MOBI({ unzlib: unzlibSync }).open(file);
  } catch (err) {
    throw new ConversionError(`This Kindle book couldn't be read (${err instanceof Error ? err.message : 'unknown error'}).`);
  }
  try {
    // KF8 books (AZW3) carry a rendition; old MOBI 6 books don't.
    const mobi6 = !book.rendition;
    const resources = new Resources();
    const chapters = new Map<number, Chapter>();
    for (let i = 0; i < book.sections.length; i++) {
      const chapter = await loadChapter(book, i, resources, mobi6);
      if (chapter) chapters.set(i, chapter);
      onProgress?.((i + 1) / book.sections.length);
    }
    if (!chapters.size) throw new ConversionError('This Kindle book has no readable text.');

    // Internal links and the table of contents.
    const counter = { n: 0 };
    for (const chapter of chapters.values()) {
      for (const a of Array.from(chapter.doc.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href')!;
        if (!/^(filepos:|kindle:)/i.test(href)) continue;
        const target = /^(filepos:|kindle:pos:)/i.test(href) ? await resolveLink(book, href, chapters, counter) : null;
        if (!target) a.removeAttribute('href');
        else a.setAttribute('href', (target.chapter === chapter ? '' : target.chapter.file) + target.fragment || target.chapter.file);
      }
    }
    const toToc = async (items: MobiTocItem[] = []): Promise<NavItem[]> => {
      const result: NavItem[] = [];
      for (const item of items) {
        const target = await resolveLink(book, item.href, chapters, counter);
        const children = await toToc(item.subitems);
        if (target) result.push({ label: item.label?.trim() || 'Untitled', href: `text/${target.chapter.file}${target.fragment}`, children });
        else result.push(...children);
      }
      return result;
    };
    let toc = await toToc(book.toc);
    if (!toc.length) {
      // No table of contents in the book: use each chapter's first heading.
      toc = [...chapters.values()].flatMap((chapter) => {
        const heading = chapter.doc.querySelector('h1, h2, h3')?.textContent?.replace(/\s+/g, ' ').trim();
        return heading ? [{ label: heading.slice(0, 120), href: `text/${chapter.file}`, children: [] }] : [];
      });
    }
    if (!toc.length) toc = [{ label: book.metadata.title || 'Start', href: `text/${chapters.values().next().value!.file}`, children: [] }];

    try {
      const cover = await book.getCover?.();
      if (cover) resources.addCover(new Uint8Array(await cover.arrayBuffer()));
    } catch {
      /* no cover */
    }
    if (mobi6) resources.items.push({ name: 'mobi.css', mime: 'text/css', data: MOBI6_CSS });

    const meta = book.metadata;
    const title = meta.title?.trim() || file.name.replace(/\.[^.]+$/, '');
    const language = (typeof meta.language === 'string' && meta.language) || 'en';
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file(
      'META-INF/container.xml',
      `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    );
    const list = [...chapters.values()];
    for (const chapter of list) zip.file(`OEBPS/text/${chapter.file}`, serialize(chapter));
    for (const item of resources.items) zip.file(`OEBPS/res/${item.name}`, item.data);
    zip.file(
      'OEBPS/nav.xhtml',
      `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${escapeXml(title)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1>${navList(toc)}</nav></body></html>`,
    );
    const manifest = [
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      ...list.map((c) => `<item id="c${c.index}" href="text/${c.file}" media-type="application/xhtml+xml"/>`),
      ...resources.items.map(
        (r, i) =>
          `<item id="res${i}" href="res/${r.name}" media-type="${r.mime}"${r.cover ? ' properties="cover-image"' : ''}/>`,
      ),
    ];
    const authors = (meta.author ?? []).filter(Boolean);
    const fixedLayout = book.rendition?.layout === 'pre-paginated';
    zip.file(
      'OEBPS/content.opf',
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:kindle:${escapeXml(meta.identifier || String(file.size))}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
${authors.map((a) => `    <dc:creator>${escapeXml(a)}</dc:creator>`).join('\n')}
    <dc:language>${escapeXml(language)}</dc:language>
${meta.publisher ? `    <dc:publisher>${escapeXml(meta.publisher)}</dc:publisher>\n` : ''}    <meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>
${fixedLayout ? '    <meta property="rendition:layout">pre-paginated</meta>\n' : ''}  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine${book.dir === 'rtl' ? ' page-progression-direction="rtl"' : ''}>
    ${list.map((c) => `<itemref idref="c${c.index}"/>`).join('\n    ')}
  </spine>
</package>`,
    );
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.epub', { type: 'application/epub+zip' });
  } finally {
    book.destroy?.();
  }
}
