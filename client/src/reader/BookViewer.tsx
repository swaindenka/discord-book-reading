import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefAttributes } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ListTree,
  Minus,
  Moon,
  Plus,
  Shrink,
  StretchHorizontal,
  Sun,
  Maximize,
  Coffee,
} from 'lucide-react';
import type { BookFormat, BookHighlight, BookInfo, HighlightAnchor, HighlightColor } from '../../../shared/types';
import { api } from '../api';
import { Menu, ProgressBar, Spinner } from '../components/ui';
import { clamp, cx, formatBytes, loadPref, savePref } from '../util';
import type {
  CueProps,
  HighlightProps,
  NavigateEvent,
  PageTheme,
  ReaderHandle,
  ReaderMeta,
  ReaderPrefs,
  ReaderProps,
  ReaderTarget,
  SelectionInfo,
  SelectionRect,
} from './types';
import { defaultPrefs } from './types';
import { HighlighterToggle, HighlightsMenu } from './HighlightTools';
import { SelectionPopover } from './SelectionPopover';
import { HighlightActions } from './HighlightActions';

type ReaderComponent = ComponentType<ReaderProps & RefAttributes<ReaderHandle>>;

// Each reader (and its library: pdf.js, epub.js, …) is only downloaded when needed.
const PdfReader = lazy(() => import('./PdfReader').then((m) => ({ default: m.PdfReader as ReaderComponent })));
const EpubReader = lazy(() => import('./EpubReader').then((m) => ({ default: m.EpubReader as ReaderComponent })));
const TextReader = lazy(() => import('./TextReader').then((m) => ({ default: m.TextReader as ReaderComponent })));
const ComicReader = lazy(() => import('./ComicReader').then((m) => ({ default: m.ComicReader as ReaderComponent })));

const READERS: Record<BookFormat, ReaderComponent> = {
  pdf: PdfReader,
  epub: EpubReader,
  txt: TextReader,
  md: TextReader,
  cbz: ComicReader,
};

const ZOOMABLE: BookFormat[] = ['pdf', 'cbz'];

async function downloadBook(url: string, onProgress: (loaded: number, total: number) => void, signal: AbortSignal) {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Download failed (${res.status})`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

const THEME_OPTIONS: { value: PageTheme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light page', Icon: Sun },
  { value: 'sepia', label: 'Sepia page', Icon: Coffee },
  { value: 'dark', label: 'Dark page', Icon: Moon },
];

export interface ViewerHighlights {
  items: BookHighlight[];
  /** Moderators and admins can add and remove highlights. */
  canEdit: boolean;
  add(color: HighlightColor, anchor: HighlightAnchor, text: string, label: string): void;
  remove(id: string): void;
}

export function BookViewer({
  book,
  target,
  onNavigate,
  cues,
  status,
  highlights,
  dictionary,
}: {
  book: BookInfo;
  target: ReaderTarget;
  onNavigate: (event: NavigateEvent) => void;
  cues: CueProps;
  status?: ReactNode;
  highlights: ViewerHighlights;
  /** Show word definitions when text is selected. */
  dictionary: boolean;
}) {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [meta, setMeta] = useState<ReaderMeta>({ label: '' });
  const [pageInput, setPageInput] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const zoomable = ZOOMABLE.includes(book.format);
  const prefsKey = `prefs:${zoomable ? 'paged' : 'flow'}`;
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPref(prefsKey, defaultPrefs(!zoomable)));
  const handle = useRef<ReaderHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [clicked, setClicked] = useState<{ id: string; rect: SelectionRect } | null>(null);
  const closeClicked = useCallback(() => setClicked(null), []);
  const [highlighter, setHighlighter] = useState(false);
  const [hlPrefs, setHlPrefs] = useState(() => loadPref('highlights', { color: 'yellow' as HighlightColor, show: true }));
  const updateHlPrefs = (patch: Partial<typeof hlPrefs>) =>
    setHlPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePref('highlights', next);
      return next;
    });
  const drawing = highlights.canEdit && highlighter;

  // Readers call back with selections; keep the latest settings in a ref so the callback is stable.
  const latest = useRef({ drawing, color: hlPrefs.color, add: highlights.add });
  latest.current = { drawing, color: hlPrefs.color, add: highlights.add };

  const onSelection = useCallback((info: SelectionInfo | null) => {
    if (info && latest.current.drawing && info.anchor) {
      latest.current.add(latest.current.color, info.anchor, info.text, info.label);
      info.clear();
      setSelection(null);
      return;
    }
    setSelection(info);
  }, []);

  // Closing the pop-over also drops the selection, so it doesn't pop up again.
  const closeSelection = useCallback(() => {
    setSelection((current) => {
      current?.clear();
      return null;
    });
  }, []);

  const readerHighlights = useMemo<HighlightProps>(
    () => ({
      items: hlPrefs.show ? highlights.items : [],
      drawing,
      color: hlPrefs.color,
      create: (anchor, text, label) => latest.current.add(latest.current.color, anchor, text, label),
      onClick: highlights.canEdit
        ? (id, rect) => {
            setSelection(null);
            setClicked({ id, rect });
          }
        : undefined,
    }),
    [hlPrefs.show, hlPrefs.color, highlights.items, highlights.canEdit, drawing],
  );

  useEffect(() => {
    if (!highlights.canEdit) setHighlighter(false);
  }, [highlights.canEdit]);

  const updatePrefs = (patch: Partial<ReaderPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePref(prefsKey, next);
      return next;
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    setMeta({ label: '' });
    downloadBook(api.bookUrl(book.id), (loaded, total) => setProgress({ loaded, total }), controller.signal)
      .then(setData)
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, [book.id, attempt]);

  useEffect(() => {
    if (meta.page) setPageInput(String(meta.page));
  }, [meta.page]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keyboard navigation (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape') setHighlighter(false);
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        handle.current?.next();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        handle.current?.prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onMeta = useCallback((next: ReaderMeta) => setMeta(next), []);
  const onError = useCallback((message: string) => setError(message), []);

  const Reader = READERS[book.format];
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
  };

  return (
    <div className={cx('viewer', fullscreen && 'is-fullscreen')} ref={rootRef}>
      <div className="viewer-toolbar">
        <div className="toolbar-group">
          <button className="icon-btn" onClick={() => handle.current?.prev()} aria-label="Previous page" title="Previous (←)">
            <ChevronLeft size={18} />
          </button>
          {meta.pageCount ? (
            <form
              className="page-jump"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(pageInput);
                if (Number.isFinite(n)) handle.current?.goToPage?.(clamp(n, 1, meta.pageCount!));
              }}
            >
              <input
                className="input page-input"
                value={pageInput}
                inputMode="numeric"
                aria-label="Page number"
                onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
                onBlur={() => meta.page && setPageInput(String(meta.page))}
              />
              <span className="muted">/ {meta.pageCount}</span>
            </form>
          ) : (
            <span className="viewer-label" title={meta.label}>
              {meta.label}
            </span>
          )}
          <button className="icon-btn" onClick={() => handle.current?.next()} aria-label="Next page" title="Next (→)">
            <ChevronRight size={18} />
          </button>
          {meta.toc && meta.toc.length > 0 && (
            <Menu label="Contents" trigger={<ListTree size={18} />} align="start">
              {(close) => (
                <div className="toc-list">
                  {meta.toc!.map((item, i) => (
                    <button
                      key={i}
                      className="menu-item"
                      style={{ paddingLeft: 12 + item.depth * 14 }}
                      onClick={() => {
                        close();
                        handle.current?.goToToc?.(item);
                      }}
                    >
                      <span className="clamp-1">{item.label}</span>
                      {item.page && <span className="muted small">{item.page}</span>}
                    </button>
                  ))}
                </div>
              )}
            </Menu>
          )}
          {(highlights.items.length > 0 || highlights.canEdit) && (
            <HighlightsMenu
              highlights={highlights.items}
              visible={hlPrefs.show}
              onToggleVisible={() => updateHlPrefs({ show: !hlPrefs.show })}
              onGo={(h) => handle.current?.goToHighlight?.(h)}
              onRemove={highlights.canEdit ? (h) => highlights.remove(h.id) : undefined}
            />
          )}
          {highlights.canEdit && (
            <HighlighterToggle
              active={highlighter}
              color={hlPrefs.color}
              areaOnly={book.format === 'cbz'}
              onToggle={() => {
                setHighlighter((on) => !on);
                if (!hlPrefs.show) updateHlPrefs({ show: true });
              }}
              onColor={(color) => updateHlPrefs({ color })}
            />
          )}
        </div>

        <div className="toolbar-group">
          {zoomable ? (
            <>
              <button
                className="icon-btn"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={() => updatePrefs({ zoom: clamp(Math.round((prefs.zoom - 0.1) * 10) / 10, 0.4, 4) })}
              >
                <Minus size={16} />
              </button>
              <button className="btn small ghost zoom-value" title="Reset zoom" onClick={() => updatePrefs({ zoom: 1 })}>
                {Math.round(prefs.zoom * 100)}%
              </button>
              <button
                className="icon-btn"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() => updatePrefs({ zoom: clamp(Math.round((prefs.zoom + 0.1) * 10) / 10, 0.4, 4) })}
              >
                <Plus size={16} />
              </button>
              <button
                className="icon-btn"
                aria-label={prefs.fit === 'width' ? 'Fit whole page' : 'Fit width'}
                title={prefs.fit === 'width' ? 'Fit whole page' : 'Fit width'}
                onClick={() => updatePrefs({ fit: prefs.fit === 'width' ? 'page' : 'width' })}
              >
                {prefs.fit === 'width' ? <Shrink size={16} /> : <StretchHorizontal size={16} />}
              </button>
            </>
          ) : (
            <>
              <button
                className="icon-btn text-size"
                aria-label="Smaller text"
                title="Smaller text"
                onClick={() => updatePrefs({ fontScale: clamp(Math.round((prefs.fontScale - 0.1) * 10) / 10, 0.7, 2) })}
              >
                A−
              </button>
              <button
                className="icon-btn text-size large"
                aria-label="Larger text"
                title="Larger text"
                onClick={() => updatePrefs({ fontScale: clamp(Math.round((prefs.fontScale + 0.1) * 10) / 10, 0.7, 2) })}
              >
                A+
              </button>
            </>
          )}
          <div className="segmented" role="radiogroup" aria-label="Page colour">
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <button
                key={value}
                role="radio"
                aria-checked={prefs.theme === value}
                className={cx(prefs.theme === value && 'active')}
                onClick={() => updatePrefs({ theme: value })}
                title={label}
                aria-label={label}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
          <button
            className="icon-btn"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            title={fullscreen ? 'Exit full screen' : 'Full screen'}
          >
            {fullscreen ? <Shrink size={16} /> : <Maximize size={16} />}
          </button>
        </div>
        {status && <div className="toolbar-status">{status}</div>}
      </div>

      <div className="viewer-body">
        {error ? (
          <div className="viewer-message">
            <p>{error}</p>
            <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <div className="viewer-message">
            <p className="muted">Downloading “{book.title}”…</p>
            <ProgressBar value={progress.total ? progress.loaded / progress.total : 0} />
            <p className="muted small">
              {formatBytes(progress.loaded)} / {formatBytes(progress.total || book.size)}
            </p>
          </div>
        ) : (
          <Suspense fallback={<Spinner label="Loading reader…" />}>
            <Reader
              key={book.id}
              ref={handle}
              book={book}
              data={data}
              target={target}
              prefs={prefs}
              onNavigate={onNavigate}
              onMeta={onMeta}
              onError={onError}
              onSelection={onSelection}
              cues={cues}
              highlights={readerHighlights}
            />
          </Suspense>
        )}
        {clicked &&
          (() => {
            const highlight = highlights.items.find((h) => h.id === clicked.id);
            return highlight ? (
              <HighlightActions
                highlight={highlight}
                rect={clicked.rect}
                onClose={closeClicked}
                onRemove={() => {
                  highlights.remove(highlight.id);
                  setClicked(null);
                }}
              />
            ) : null;
          })()}
        {selection && !drawing && !clicked && (
          <SelectionPopover
            info={selection}
            canHighlight={highlights.canEdit}
            dictionary={dictionary}
            onClose={closeSelection}
            onHighlight={(color) => {
              if (selection.anchor) highlights.add(color, selection.anchor, selection.text, selection.label);
              updateHlPrefs({ color, show: true });
              selection.clear();
              setSelection(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
