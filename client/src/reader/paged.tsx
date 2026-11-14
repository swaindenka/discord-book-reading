import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { clamp, colorFor, throttle } from '../util';
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

  const goToPage = useCallback(
    (requested: number) => {
      if (!pageCount) return;
      const next = clamp(Math.round(requested), 1, pageCount);
      if (next === pageRef.current) return;
      const position = { kind: 'page' as const, page: next };
      lastKey.current = `${versionRef.current}|${positionKey(position)}`;
      showPage(next, TOP);
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

/**
 * Wraps a page so the current reader's mouse pointer is shown to everyone following,
 * like the cursor on a screen share.
 */
export function PointerSurface({
  page,
  cues,
  bookId,
  className,
  children,
  style,
}: {
  page: number;
  cues: CueProps;
  bookId: string;
  className?: string;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const send = useRef(throttle((p: number, x: number | null, y: number | null) => cues.sendPointer(p, x, y), 50)).current;
  const sendRef = useRef(cues.sendPointer);
  sendRef.current = cues.sendPointer;
  const [visible, setVisible] = useState(false);
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

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!cues.canSend || e.pointerType === 'touch') return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    send(page, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  };
  const onLeave = () => {
    if (!cues.canSend) return;
    send.cancel();
    sendRef.current(page, null, null);
  };

  return (
    <div ref={ref} className={className} style={style} onPointerMove={onMove} onPointerLeave={onLeave}>
      {children}
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
