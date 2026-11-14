import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import { marked, type Token, type TokensList } from 'marked';
import DOMPurify from 'dompurify';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../../../shared/types';
import { usePagedSync } from './paged';
import { clearDomSelection, rangeFromOffsets, rectOf, textOffsets, useSelectionWatcher } from './selection';
import type { ReaderHandle, ReaderProps, TocItem } from './types';
import { cx } from '../util';

const PAGE_CHARS = 3200;

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function decode(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Splits text into pages at paragraph boundaries, so every reader gets identical page numbers. */
function paginate<T>(items: T[], size: (item: T) => number): T[][] {
  const pages: T[][] = [];
  let current: T[] = [];
  let length = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length && length + n > PAGE_CHARS) {
      pages.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += n;
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= PAGE_CHARS * 1.5) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) ?? [paragraph];
  const parts: string[] = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > PAGE_CHARS) {
      parts.push(buffer.trim());
      buffer = '';
    }
    buffer += sentence;
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

function plainTextPages(text: string): { pages: string[]; toc: TocItem[] } {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\s+$/g, ''))
    .filter((p) => p.trim())
    .flatMap(splitLong);
  const toc: TocItem[] = [];
  const pages = paginate(paragraphs, (p) => p.length + 40).map((group, index) =>
    group
      .map((p) => {
        const lines = p.split('\n');
        const avg = lines.reduce((sum, l) => sum + l.trim().length, 0) / lines.length;
        // Keep line breaks for verse and lists; re-flow hard-wrapped prose.
        const body = lines.length > 1 && avg < 48 ? lines.map((l) => escapeHtml(l)).join('<br>') : escapeHtml(lines.map((l) => l.trim()).join(' '));
        const heading = /^(chapter|part|book|section|prologue|epilogue)\b[^\n]{0,60}$/i.test(p.trim());
        if (heading) toc.push({ label: p.trim().slice(0, 80), depth: 0, page: index + 1 });
        return heading ? `<h2>${body}</h2>` : `<p>${body}</p>`;
      })
      .join('\n'),
  );
  return { pages, toc };
}

function markdownPages(text: string): { pages: string[]; toc: TocItem[] } {
  const tokens = marked.lexer(text);
  const toc: TocItem[] = [];
  const groups = paginate(tokens as Token[], (t) => ('raw' in t ? t.raw.length : 0) + 20);
  const pages = groups.map((group, index) => {
    for (const token of group) {
      if (token.type === 'heading' && token.depth <= 3) {
        toc.push({ label: token.text.slice(0, 80), depth: token.depth - 1, page: index + 1 });
      }
    }
    const list = Object.assign([...group], { links: (tokens as TokensList).links }) as TokensList;
    return DOMPurify.sanitize(marked.parser(list), { FORBID_TAGS: ['style', 'form', 'input', 'iframe'] });
  });
  return { pages, toc };
}

const COLOR_NAMES = Object.keys(HIGHLIGHT_COLORS) as HighlightColor[];
const supportsHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS;

export const TextReader = forwardRef<ReaderHandle, ReaderProps>(function TextReader(
  { book, data, target, prefs, onNavigate, onMeta, onSelection, highlights },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const { pages, toc } = useMemo(() => {
    const text = decode(data);
    return book.format === 'md' ? markdownPages(text) : plainTextPages(text);
  }, [data, book.format]);
  const { page, goToPage, markRendered, onScroll } = usePagedSync({ pageCount: pages.length, target, onNavigate, scrollRef });

  useImperativeHandle(
    ref,
    () => ({
      next: () => goToPage(page + 1),
      prev: () => goToPage(page - 1),
      goToPage,
      goToToc: (item) => item.page && goToPage(item.page),
      goToHighlight: (h) => {
        if (h.anchor.kind !== 'text') return;
        if (h.anchor.page !== page) {
          goToPage(h.anchor.page);
          return;
        }
        const range = articleRef.current && rangeFromOffsets(articleRef.current, h.anchor.start, h.anchor.end);
        range?.startContainer.parentElement?.scrollIntoView({ block: 'center' });
      },
    }),
    [goToPage, page],
  );

  useSelectionWatcher(articleRef, (range) => {
    const article = articleRef.current;
    if (!range || !article) return onSelection(null);
    const offsets = textOffsets(article, range);
    onSelection({
      text: range.toString(),
      rect: rectOf(range),
      anchor: offsets ? { kind: 'text', page, ...offsets } : null,
      label: `Page ${page}`,
      clear: clearDomSelection,
    });
  });

  // Paint highlights with the CSS Custom Highlight API (no DOM changes needed).
  useLayoutEffect(() => {
    const article = articleRef.current;
    if (!supportsHighlights || !article) return;
    const byColor = new Map<HighlightColor, Range[]>();
    for (const h of highlights.items) {
      if (h.anchor.kind !== 'text' || h.anchor.page !== page) continue;
      const range = rangeFromOffsets(article, h.anchor.start, h.anchor.end);
      if (range) byColor.set(h.color, [...(byColor.get(h.color) ?? []), range]);
    }
    for (const color of COLOR_NAMES) {
      const ranges = byColor.get(color);
      if (ranges?.length) CSS.highlights.set(`rr-${color}`, new Highlight(...ranges));
      else CSS.highlights.delete(`rr-${color}`);
    }
  }, [highlights.items, page, pages]);

  useEffect(
    () => () => {
      if (supportsHighlights) COLOR_NAMES.forEach((color) => CSS.highlights.delete(`rr-${color}`));
    },
    [],
  );

  useEffect(() => {
    onMeta({ label: `Page ${page} of ${pages.length}`, page, pageCount: pages.length, toc });
  }, [page, pages.length, toc, onMeta]);

  useLayoutEffect(() => {
    markRendered(page);
  }, [page, prefs.fontScale, markRendered]);

  return (
    <div className={cx('paged-scroll text-scroll', `page-theme-${prefs.theme}`)} ref={scrollRef} onScroll={onScroll}>
      <article
        ref={articleRef}
        className={cx('text-page', book.format === 'md' && 'markdown')}
        style={{ fontSize: `${1.12 * prefs.fontScale}rem` }}
        // Plain text is escaped; Markdown output is sanitised with DOMPurify.
        dangerouslySetInnerHTML={{ __html: pages[page - 1] ?? '' }}
      />
    </div>
  );
});
