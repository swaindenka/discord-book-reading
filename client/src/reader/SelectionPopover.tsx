import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookA, ExternalLink, Highlighter } from 'lucide-react';
import { HIGHLIGHT_COLORS, type DictionaryResult, type HighlightColor } from '../../../shared/types';
import { normalizeQuery } from '../../../shared/text';
import { api } from '../api';
import { clamp } from '../util';
import type { SelectionInfo } from './types';

const WIDTH = 340;
const cache = new Map<string, Promise<DictionaryResult>>();

function lookUp(query: string) {
  let pending = cache.get(query);
  if (!pending) {
    pending = api.define(query);
    pending.catch(() => cache.delete(query));
    cache.set(query, pending);
  }
  return pending;
}

type Lookup = { status: 'loading' } | { status: 'done'; result: DictionaryResult } | { status: 'error'; message: string };

/**
 * Appears next to a text selection: word definitions for everyone, and (for moderators)
 * one-click highlight colours.
 */
export function SelectionPopover({
  info,
  canHighlight,
  dictionary,
  onHighlight,
  onClose,
}: {
  info: SelectionInfo;
  canHighlight: boolean;
  dictionary: boolean;
  onHighlight: (color: HighlightColor) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const query = dictionary ? normalizeQuery(info.text) : null;
  const showHighlight = canHighlight && info.anchor !== null;
  const [lookup, setLookup] = useState<Lookup>({ status: 'loading' });
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!query) return;
    let alive = true;
    setLookup({ status: 'loading' });
    lookUp(query).then(
      (result) => alive && setLookup({ status: 'done', result }),
      (err: Error) => alive && setLookup({ status: 'error', message: err.message }),
    );
    return () => {
      alive = false;
    };
  }, [query]);

  // Place it under the selection, or above when there's no room below.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    const centre = (info.rect.left + info.rect.right) / 2;
    const left = clamp(centre - WIDTH / 2, 8, Math.max(8, window.innerWidth - WIDTH - 8));
    let top = info.rect.bottom + 10;
    if (top + height > window.innerHeight - 8) top = Math.max(8, info.rect.top - height - 10);
    setPosition({ left, top });
  }, [info, lookup]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Scrolling the page by hand moves the text away from the pop-over.
    const onWheel = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    document.addEventListener('touchmove', onWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('touchmove', onWheel, true);
    };
  }, [onClose]);

  if (!query && !showHighlight) return null;

  const entry = lookup.status === 'done' ? lookup.result.entry : null;
  const oxfordUrl =
    lookup.status === 'done'
      ? lookup.result.oxfordUrl
      : `https://www.oxfordlearnersdictionaries.com/search/english/?q=${encodeURIComponent(query ?? '')}`;

  return (
    <div
      ref={ref}
      className="selection-popover"
      role="dialog"
      aria-label={query ? `Definition of ${query}` : 'Highlight selection'}
      style={{ width: WIDTH, left: position?.left ?? -9999, top: position?.top ?? -9999 }}
      // Keep the text selected while clicking inside the pop-over.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLAnchorElement)) e.preventDefault();
      }}
    >
      {showHighlight && (
        <div className="popover-highlight">
          <Highlighter size={15} aria-hidden />
          <span>Highlight</span>
          <div className="swatches">
            {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((color) => (
              <button
                key={color}
                className="swatch"
                style={{ background: HIGHLIGHT_COLORS[color].css }}
                aria-label={`Highlight in ${HIGHLIGHT_COLORS[color].label.toLowerCase()}`}
                title={HIGHLIGHT_COLORS[color].label}
                onClick={() => onHighlight(color)}
              />
            ))}
          </div>
        </div>
      )}

      {query && (
        <div className="dict">
          <div className="dict-head">
            <BookA size={16} aria-hidden />
            <strong>{entry?.word || query}</strong>
            {entry?.phonetic && <span className="muted">{entry.phonetic}</span>}
          </div>
          <div className="dict-body">
            {lookup.status === 'loading' && <p className="muted small">Looking it up…</p>}
            {lookup.status === 'error' && <p className="muted small">{lookup.message}</p>}
            {lookup.status === 'done' && !entry && <p className="muted small">No definition found. Try the Oxford link below.</p>}
            {entry?.senses.map((sense, i) => (
              <div key={i} className="dict-sense">
                {sense.partOfSpeech && <em className="dict-pos">{sense.partOfSpeech}</em>}
                <ol>
                  {sense.definitions.map((d, j) => (
                    <li key={j}>
                      {d.text}
                      {d.example && <div className="dict-example">“{d.example}”</div>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          <div className="dict-foot">
            <a href={oxfordUrl} target="_blank" rel="noopener noreferrer">
              Oxford Learner's Dictionary <ExternalLink size={12} aria-hidden />
            </a>
            {entry && <span className="muted small">{entry.sourceLabel}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
