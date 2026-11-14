import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { HIGHLIGHT_COLORS, type BookHighlight } from '../../../shared/types';
import { clamp } from '../util';
import type { SelectionRect } from './types';

const WIDTH = 280;

/** Small menu that opens when a moderator clicks a saved highlight. */
export function HighlightActions({
  highlight,
  rect,
  onRemove,
  onClose,
}: {
  highlight: BookHighlight;
  rect: SelectionRect;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    const centre = (rect.left + rect.right) / 2;
    const left = clamp(centre - WIDTH / 2, 8, Math.max(8, window.innerWidth - WIDTH - 8));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    setPosition({ left, top });
  }, [rect]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onWheel = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('wheel', onWheel, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="selection-popover highlight-actions"
      role="dialog"
      aria-label="Highlight"
      style={{ width: WIDTH, left: position?.left ?? -9999, top: position?.top ?? -9999 }}
    >
      <div className="highlight-actions-body">
        <span className="hl-dot" style={{ background: HIGHLIGHT_COLORS[highlight.color].css }} aria-hidden />
        <div className="hl-item-text">
          <span className="clamp-2">{highlight.text || 'Marked area'}</span>
          <span className="muted small">
            {[highlight.label, `by ${highlight.createdByName}`].filter(Boolean).join(' · ')}
          </span>
        </div>
        <button className="icon-btn ghost" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <button className="btn danger block" onClick={onRemove} autoFocus>
        <Trash2 size={15} /> Remove highlight
      </button>
    </div>
  );
}
