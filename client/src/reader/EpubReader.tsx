import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import ePub, { EpubCFI } from 'epubjs';
import type { Book, Rendition } from 'epubjs';
import { HIGHLIGHT_COLORS, type Position } from '../../../shared/types';
import { Spinner } from '../components/ui';
import { cx } from '../util';
import type { PageTheme, ReaderHandle, ReaderProps, TocItem } from './types';
import { positionKey } from './types';
import { rectOf } from './selection';

const THEMES: Record<PageTheme, { color: string; background: string; link: string }> = {
  light: { color: '#1f2328', background: '#ffffff', link: '#3b5bdb' },
  sepia: { color: '#433422', background: '#f4ecd8', link: '#8a4b0f' },
  dark: { color: '#d7dae0', background: '#1b1c20', link: '#8fa8ff' },
};

interface EpubLocation {
  start: { cfi: string; href: string; percentage?: number; displayed?: { page: number; total: number } };
}

interface NavItemLike {
  label: string;
  href: string;
  subitems?: NavItemLike[];
}

function flattenToc(items: NavItemLike[], depth = 0, out: TocItem[] = []): TocItem[] {
  for (const item of items) {
    out.push({ label: item.label.trim() || 'Untitled', href: item.href, depth });
    if (item.subitems?.length) flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

const baseName = (href: string) => href.split('#')[0].split('/').pop() ?? href;

export const EpubReader = forwardRef<ReaderHandle, ReaderProps>(function EpubReader(
  { book: info, data, target, prefs, onNavigate, onMeta, onError, onSelection, cues, highlights },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [ready, setReady] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [locationsReady, setLocationsReady] = useState(false);
  const locationsReadyRef = useRef(false);
  const lastKey = useRef<string | null>(null);
  const userNavPending = useRef(false);
  const currentLocation = useRef<EpubLocation | null>(null);
  /** The live selection cue: ours when we lead, the reader's when we follow. */
  const sharedSelection = useRef<string | null>(null);
  /** Saved highlights currently drawn: id -> CFI range. */
  const drawn = useRef(new Map<string, string>());

  const latest = useRef({ target, onNavigate, onMeta, onSelection, cues, toc });
  latest.current = { target, onNavigate, onMeta, onSelection, cues, toc };

  const chapterFor = (href: string) => {
    const name = baseName(href);
    return latest.current.toc.find((item) => item.href && baseName(item.href) === name)?.label;
  };

  const describe = (location: EpubLocation): Position => {
    const book = bookRef.current;
    let percent: number | undefined;
    if (book && locationsReadyRef.current) {
      const value = book.locations.percentageFromCfi(location.start.cfi);
      if (typeof value === 'number' && Number.isFinite(value)) percent = Math.round(value * 1000) / 10;
    }
    const label = chapterFor(location.start.href);
    const position: Position = { kind: 'cfi', cfi: location.start.cfi };
    if (percent !== undefined) position.percent = percent;
    if (label) position.label = label;
    return position;
  };

  const updateMeta = (location: EpubLocation) => {
    const position = describe(location);
    const parts = [position.kind === 'cfi' && position.label, position.kind === 'cfi' && position.percent !== undefined && `${Math.round(position.percent)}%`];
    const displayed = location.start.displayed;
    if (!parts[1] && displayed) parts.push(`page ${displayed.page} of ${displayed.total} in chapter`);
    latest.current.onMeta({ label: parts.filter(Boolean).join(' · ') || 'Reading', toc: latest.current.toc });
  };

  const reportUserNavigation = () => {
    const location = currentLocation.current;
    if (!location) return;
    const position = describe(location);
    lastKey.current = `${latest.current.target.version}|${positionKey(position)}`;
    latest.current.onNavigate({ position, scrollOnly: false });
    if (latest.current.cues.canSend && sharedSelection.current) {
      sharedSelection.current = null;
      latest.current.cues.sendSelection(null);
    }
  };

  // Open the book and create the rendition.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    const book = ePub(data.slice(0) as ArrayBuffer);
    bookRef.current = book;
    const rendition = book.renderTo(host, {
      width: '100%',
      height: '100%',
      flow: 'paginated',
      spread: 'none',
      allowScriptedContent: false,
    } as Parameters<Book['renderTo']>[1]);
    renditionRef.current = rendition;

    for (const [name, theme] of Object.entries(THEMES)) {
      rendition.themes.register(name, {
        'html, body': { color: `${theme.color} !important`, background: `${theme.background} !important` },
        'a, a:link, a:visited': { color: `${theme.link} !important` },
        p: { 'line-height': '1.6' },
        img: { 'max-width': '100%' },
      });
    }

    rendition.on('relocated', (location: EpubLocation) => {
      currentLocation.current = location;
      updateMeta(location);
      latest.current.onSelection(null);
      if (userNavPending.current) {
        userNavPending.current = false;
        reportUserNavigation();
      }
    });

    // epub.js reports a selection once it stops changing for a moment, which can be mid-drag.
    // Hold it until the mouse/finger is released so highlights cover the whole selection.
    let pressed = false;
    let pending: { cfiRange: string; contents: { window: Window } } | null = null;

    const reportSelection = (cfiRange: string, contents: { window: Window }) => {
      if (latest.current.cues.canSend) {
        sharedSelection.current = cfiRange;
        latest.current.cues.sendSelection(cfiRange);
      }
      // The selection lives inside the book's iframe; translate its position to the page.
      const range = rendition.getRange(cfiRange) as Range | null;
      const frame = (contents.window.frameElement as HTMLElement | null)?.getBoundingClientRect();
      if (!range || !range.toString().trim()) return;
      latest.current.onSelection({
        text: range.toString(),
        rect: rectOf(range, { x: frame?.left ?? 0, y: frame?.top ?? 0 }),
        anchor: { kind: 'cfi', cfiRange },
        label: (currentLocation.current && chapterFor(currentLocation.current.start.href)) || '',
        clear: () => contents.window.getSelection()?.removeAllRanges(),
      });
    };

    rendition.on('selected', (cfiRange: string, contents: { window: Window }) => {
      if (pressed) pending = { cfiRange, contents };
      else reportSelection(cfiRange, contents);
    });
    const press = () => {
      pressed = true;
      pending = null;
      latest.current.onSelection(null);
    };
    const release = () => {
      pressed = false;
      // Give epub.js a moment to report the final selection, then pass it on.
      setTimeout(() => {
        if (pending && !pressed) {
          const { cfiRange, contents } = pending;
          pending = null;
          reportSelection(cfiRange, contents);
        }
      }, 300);
    };
    rendition.on('mousedown', press);
    rendition.on('touchstart', press);
    rendition.on('mouseup', release);
    rendition.on('touchend', release);

    // Arrow keys while the book iframe has focus.
    rendition.on('keyup', (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') void goNext();
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') void goPrev();
    });

    // Internal links (footnotes, chapter links) count as the reader navigating.
    rendition.hooks.content.register((contents: { on: (e: string, cb: () => void) => void }) => {
      contents.on('linkClicked', () => {
        userNavPending.current = true;
      });
    });

    book.ready
      .then(async () => {
        if (!alive) return;
        setToc(flattenToc((book.navigation?.toc ?? []) as NavItemLike[]));
        const start = latest.current.target.position;
        lastKey.current = `${latest.current.target.version}|${positionKey(start)}`;
        await rendition.display(start?.kind === 'cfi' ? start.cfi : undefined).catch(() => rendition.display());
        if (!alive) return;
        setReady(true);
        // Percentages need a full pass over the book; do it in the background.
        await book.locations.generate(1600);
        if (!alive) return;
        locationsReadyRef.current = true;
        setLocationsReady(true);
      })
      .catch((err: Error) => alive && onError(`Could not open this EPUB: ${err.message}`));

    return () => {
      alive = false;
      renditionRef.current = null;
      bookRef.current = null;
      try {
        book.destroy();
      } catch {
        /* already gone */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const goNext = async () => {
    userNavPending.current = true;
    await renditionRef.current?.next();
  };
  const goPrev = async () => {
    userNavPending.current = true;
    await renditionRef.current?.prev();
  };

  useImperativeHandle(ref, () => ({
    next: () => void goNext(),
    prev: () => void goPrev(),
    goToToc: (item) => {
      if (!item.href || !renditionRef.current) return;
      userNavPending.current = true;
      void renditionRef.current.display(item.href);
    },
    goToHighlight: (h) => {
      if (h.anchor.kind !== 'cfi' || !renditionRef.current) return;
      let start = h.anchor.cfiRange;
      try {
        const cfi = new EpubCFI(h.anchor.cfiRange);
        cfi.collapse(true);
        start = cfi.toString();
      } catch {
        /* use the range as is */
      }
      userNavPending.current = true;
      void renditionRef.current.display(start);
    },
  }));

  // Follow the target position.
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!ready || !rendition) return;
    const position = target.position?.kind === 'cfi' ? target.position : null;
    const key = `${target.version}|${positionKey(position)}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (position) {
      userNavPending.current = false;
      void rendition.display(position.cfi).catch(() => {});
    }
  }, [target, ready]);

  // Theme and font size.
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    rendition.themes.select(prefs.theme);
    rendition.themes.fontSize(`${Math.round(prefs.fontScale * 100)}%`);
  }, [prefs.theme, prefs.fontScale, ready]);

  useEffect(() => {
    if (currentLocation.current) updateMeta(currentLocation.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toc, locationsReady]);

  // Underline the reader's current text selection for everyone following.
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition || !ready || cues.canSend) return;
    const incoming = cues.selection && cues.selection.bookId === info.id ? cues.selection.cfiRange : null;
    const previous = sharedSelection.current;
    if (previous && previous !== incoming) {
      try {
        rendition.annotations.remove(previous, 'underline');
      } catch {
        /* not rendered */
      }
    }
    sharedSelection.current = incoming;
    if (incoming && incoming !== previous) {
      try {
        rendition.annotations.underline(incoming, {}, () => {}, 'rr-selection', { stroke: '#f08c00', 'stroke-width': '2' });
      } catch {
        /* range not visible */
      }
    }
  }, [cues.selection, cues.canSend, ready, info.id]);

  // Saved highlights. Redrawn when the page colour changes so they stay readable.
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition || !ready) return;
    const wanted = new Map(
      highlights.items.flatMap((h) => (h.anchor.kind === 'cfi' ? [[h.id, { range: h.anchor.cfiRange, color: h.color }] as const] : [])),
    );
    const remove = (id: string) => {
      try {
        rendition.annotations.remove(drawn.current.get(id)!, 'highlight');
      } catch {
        /* not rendered */
      }
      drawn.current.delete(id);
    };
    for (const id of [...drawn.current.keys()]) if (!wanted.has(id)) remove(id);
    const dark = prefs.theme === 'dark';
    for (const [id, { range, color }] of wanted) {
      if (drawn.current.has(id)) continue;
      try {
        rendition.annotations.highlight(range, { id }, () => {}, 'rr-mark', {
          fill: HIGHLIGHT_COLORS[color].css,
          'fill-opacity': dark ? '0.3' : '0.45',
          'mix-blend-mode': dark ? 'normal' : 'multiply',
        });
        drawn.current.set(id, range);
      } catch {
        /* invalid range */
      }
    }
  }, [highlights.items, ready, prefs.theme]);

  useEffect(() => {
    // Theme change: drop everything so the effect above redraws with matching colours.
    const rendition = renditionRef.current;
    return () => {
      if (!rendition) return;
      for (const range of drawn.current.values()) {
        try {
          rendition.annotations.remove(range, 'highlight');
        } catch {
          /* gone */
        }
      }
      drawn.current.clear();
    };
  }, [prefs.theme, ready]);

  return (
    <div className={cx('epub-wrap', `page-theme-${prefs.theme}`)}>
      {!ready && <Spinner label="Opening EPUB…" />}
      <button className="epub-tap prev" aria-hidden tabIndex={-1} title="Previous page" onClick={() => void goPrev()} />
      <div className="epub-host" ref={hostRef} />
      <button className="epub-tap next" aria-hidden tabIndex={-1} title="Next page" onClick={() => void goNext()} />
    </div>
  );
});
