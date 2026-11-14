import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../../../shared/types';
import { clamp, colorFor, cx, throttle } from '../util';
import type { CueProps, NavigateEvent, ReaderTarget } from './types';
import { positionKey, roundScroll } from './types';

const TOP = -1;

/**
 * Shared page/scroll synchronisation for page-based readers (PDF, comics, text).
 * The page scrolls inside `scrollRef`; positions report the point of the page in the
 * middle of the screen so people with different window sizes see the same lines.
 */
export function usePagedSync({
  pageCount,
  target,
  onNavigate,
  scrollRef,
}: {
  pageCount: number;
  target: ReaderTarget;
  onNavigate: (event: NavigateEvent) => void;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const [page, setPage] = useState(1);
  const pageRef = useRef(1);
  const lastKey = useRef<string | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const suppressUntil = useRef(0);
  const renderedPage = useRef<number | null>(null);
  const versionRef = useRef(target.version);
  versionRef.current = target.version;
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;

  const applyPendingScroll = useCallback(() => {
    const el = scrollRef.current;
    const wanted = pendingScroll.current;
    if (!el || wanted === null) return;
    pendingScroll.current = null;
    suppressUntil.current = performance.now() + 250;
    el.scrollTop = wanted === TOP ? 0 : wanted * el.scrollHeight - el.clientHeight / 2;
  }, [scrollRef]);

  const showPage = useCallback(
    (next: number, scroll: number) => {
      pendingScroll.current = scroll;
      if (next !== pageRef.current) {
        pageRef.current = next;
        renderedPage.current = null;
        setPage(next);
      } else if (renderedPage.current === next) {
        applyPendingScroll();
      }
    },
    [applyPendingScroll],
  );

  // Follow the target position (the room's or our own local one).
  useEffect(() => {
    if (!pageCount) return;
    const position = target.position?.kind === 'page' ? target.position : null;
    const key = `${target.version}|${positionKey(position)}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (!position) return;
    showPage(clamp(position.page, 1, pageCount), position.scroll ?? TOP);
  }, [target, pageCount, showPage]);

  /** Readers call this once the current page's content is laid out. */
  const markRendered = useCallback(
    (renderedFor: number) => {
      if (renderedFor !== pageRef.current) return;
      renderedPage.current = renderedFor;
      suppressUntil.current = performance.now() + 250;
      applyPendingScroll();
    },
    [applyPendingScroll],
  );

  /** Goes to a page; `scroll` (0–1) centres that point of the page, otherwise the top is shown. */
  const goToPage = useCallback(
    (requested: number, scroll?: number) => {
      if (!pageCount) return;
      const next = clamp(Math.round(requested), 1, pageCount);
      if (next === pageRef.current && scroll === undefined) return;
      const position =
        scroll === undefined ? { kind: 'page' as const, page: next } : { kind: 'page' as const, page: next, scroll: roundScroll(scroll) };
      lastKey.current = `${versionRef.current}|${positionKey(position)}`;
      showPage(next, position.scroll ?? TOP);
      navigateRef.current({ position, scrollOnly: false });
    },
    [pageCount, showPage],
  );

  const reportScroll = useRef(
    throttle((scroll: number, forPage: number) => {
      const position = { kind: 'page' as const, page: forPage, scroll };
      lastKey.current = `${versionRef.current}|${positionKey(position)}`;
      navigateRef.current({ position, scrollOnly: true });
    }, 150),
  ).current;

  useEffect(() => () => reportScroll.cancel(), [reportScroll]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || performance.now() < suppressUntil.current || renderedPage.current !== pageRef.current) return;
    if (el.scrollHeight <= el.clientHeight + 2) return;
    reportScroll(roundScroll((el.scrollTop + el.clientHeight / 2) / el.scrollHeight), pageRef.current);
  }, [scrollRef, reportScroll]);

  return { page, goToPage, markRendered, onScroll };
}

/** Watches an element's size. */
export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { width, height } = entry.contentRect;
        setSize((prev) =>
          Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
            ? prev
            : { width: Math.floor(width), height: Math.floor(height) },
        );
      });
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
  return size;
}

type Box = [number, number, number, number];

export interface PageHighlight {
  id: string;
  color: HighlightColor;
  rects: Box[];
}

export interface AreaDraw {
  enabled: boolean;
  color: HighlightColor;
  /** Whether a drag starting on this element should draw (PDF text should stay selectable). */
  canStart?(target: EventTarget | null): boolean;
  onDone(box: Box): void;
}

/**
 * Wraps a page (PDF or comic). It shows the current reader's mouse pointer to everyone
 * following, like the cursor on a screen share, draws saved highlights, and lets
 * moderators drag out an area highlight while the highlighter is on.
 */
export function PointerSurface({
  page,
  cues,
  bookId,
  className,
  children,
  style,
  highlights = [],
  draw,
  surfaceRef,
  onHighlightClick,
}: {
  page: number;
  cues: CueProps;
  bookId: string;
  className?: string;
  children: ReactNode;
  style?: React.CSSProperties;
  highlights?: PageHighlight[];
  draw?: AreaDraw;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  onHighlightClick?: (id: string, rect: { left: number; top: number; right: number; bottom: number }) => void;
}) {
  const justDrew = useRef(false);
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = surfaceRef ?? ownRef;
  const send = useRef(throttle((p: number, x: number | null, y: number | null) => cues.sendPointer(p, x, y), 50)).current;
  const sendRef = useRef(cues.sendPointer);
  sendRef.current = cues.sendPointer;
  const [visible, setVisible] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pointer = cues.pointer;
  const showRemote = pointer && pointer.bookId === bookId && pointer.page === page && pointer.x !== null && pointer.y !== null;

  useEffect(() => () => send.cancel(), [send]);

  useEffect(() => {
    if (!showRemote) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2500);
    return () => clearTimeout(timer);
  }, [pointer, showRemote]);

  const relative = (e: ReactPointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draw?.enabled || e.button !== 0) return;
    if (draw.canStart && !draw.canStart(e.target)) return;
    const point = relative(e);
    if (!point) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag) {
      const point = relative(e);
      if (point) setDrag({ ...drag, x1: point.x, y1: point.y });
    }
    if (!cues.canSend || e.pointerType === 'touch') return;
    const point = relative(e);
    if (point) send(page, point.x, point.y);
  };

  const onUp = () => {
    if (!drag || !draw) return;
    const box: Box = [
      Math.min(drag.x0, drag.x1),
      Math.min(drag.y0, drag.y1),
      Math.abs(drag.x1 - drag.x0),
      Math.abs(drag.y1 - drag.y0),
    ];
    setDrag(null);
    justDrew.current = box[2] > 0.01 && box[3] > 0.005;
    if (box[2] > 0.01 && box[3] > 0.005) draw.onDone(box.map((n) => Math.round(n * 10000) / 10000) as Box);
  };

  // Clicking a saved highlight (without selecting text or drawing) opens its menu.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (justDrew.current) {
      justDrew.current = false;
      return;
    }
    if (!onHighlightClick || !window.getSelection()?.isCollapsed) return;
    const surface = ref.current?.getBoundingClientRect();
    if (!surface || !surface.width) return;
    const x = (e.clientX - surface.left) / surface.width;
    const y = (e.clientY - surface.top) / surface.height;
    const pad = 0.004;
    for (const h of [...highlights].reverse()) {
      const hit = h.rects.find(([rx, ry, rw, rh]) => x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad);
      if (hit) {
        onHighlightClick(h.id, {
          left: surface.left + hit[0] * surface.width,
          top: surface.top + hit[1] * surface.height,
          right: surface.left + (hit[0] + hit[2]) * surface.width,
          bottom: surface.top + (hit[1] + hit[3]) * surface.height,
        });
        return;
      }
    }
  };

  const onLeave = () => {
    if (!cues.canSend) return;
    send.cancel();
    sendRef.current(page, null, null);
  };

  const box = (b: Box) => ({ left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${b[2] * 100}%`, height: `${b[3] * 100}%` });

  return (
    <div
      ref={ref}
      className={cx(className, draw?.enabled && 'drawing')}
      style={style}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onClick={onClick}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={onLeave}
    >
      {children}
      {highlights.length > 0 && (
        <div className="hl-layer" aria-hidden>
          {highlights.flatMap((h) =>
            h.rects.map((r, i) => (
              <div key={`${h.id}-${i}`} className="hl-box" style={{ ...box(r), background: HIGHLIGHT_COLORS[h.color].css }} />
            )),
          )}
        </div>
      )}
      {drag && draw && (
        <div
          className="hl-draft"
          style={{
            ...box([Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)]),
            borderColor: HIGHLIGHT_COLORS[draw.color].css,
            background: HIGHLIGHT_COLORS[draw.color].css,
          }}
        />
      )}
      {showRemote && (
        <div
          className={`remote-pointer ${visible ? 'visible' : ''}`}
          style={{ left: `${pointer.x! * 100}%`, top: `${pointer.y! * 100}%`, ['--pointer-color' as string]: colorFor(pointer.userId) }}
          aria-hidden
        >
          <span className="remote-pointer-dot" />
          <span className="remote-pointer-name">{cues.pointerName}</span>
        </div>
      )}
    </div>
  );
}

/** Highlights that sit on `page` as boxes (PDF and comics). */
export function pageBoxes(items: { id: string; color: HighlightColor; anchor: { kind: string } }[], page: number): PageHighlight[] {
  const out: PageHighlight[] = [];
  for (const h of items) {
    const anchor = h.anchor as { kind: string; page?: number; rects?: Box[] };
    if (anchor.kind === 'rects' && anchor.page === page && anchor.rects) out.push({ id: h.id, color: h.color, rects: anchor.rects });
  }
  return out;
}
