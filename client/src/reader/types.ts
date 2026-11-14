import type { BookInfo, HighlightEvent, PointerEvent, Position } from '../../../shared/types';

/** Where the reader should be. `version` bumps force a jump even to the same position. */
export interface ReaderTarget {
  position: Position | null;
  version: number;
}

export interface TocItem {
  label: string;
  depth: number;
  /** EPUB chapter href. */
  href?: string;
  /** PDF page number. */
  page?: number;
}

export interface ReaderMeta {
  label: string;
  page?: number;
  pageCount?: number;
  toc?: TocItem[];
}

export interface ReaderHandle {
  next(): void;
  prev(): void;
  goToPage?(page: number): void;
  goToToc?(item: TocItem): void;
}

export type Fit = 'width' | 'page';
export type PageTheme = 'light' | 'sepia' | 'dark';

export interface ReaderPrefs {
  zoom: number;
  fit: Fit;
  fontScale: number;
  theme: PageTheme;
}

export const DEFAULT_PREFS: ReaderPrefs = { zoom: 1, fit: 'width', fontScale: 1, theme: 'light' };

/** Reflowable text follows the system colour scheme by default; scanned pages stay light. */
export function defaultPrefs(reflowable: boolean): ReaderPrefs {
  const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return { ...DEFAULT_PREFS, theme: reflowable && dark ? 'dark' : 'light' };
}

export interface NavigateEvent {
  position: Position;
  /** True when only the scroll offset within the same page changed. */
  scrollOnly: boolean;
}

export interface CueProps {
  /** You control the room's page, so your pointer/highlight is shared. */
  canSend: boolean;
  pointer: PointerEvent | null;
  highlight: HighlightEvent | null;
  pointerName: string;
  sendPointer(page: number, x: number | null, y: number | null): void;
  sendHighlight(cfiRange: string | null): void;
}

export interface ReaderProps {
  book: BookInfo;
  data: ArrayBuffer;
  target: ReaderTarget;
  prefs: ReaderPrefs;
  onNavigate(event: NavigateEvent): void;
  onMeta(meta: ReaderMeta): void;
  onError(message: string): void;
  cues: CueProps;
}

export function positionKey(position: Position | null | undefined): string {
  if (!position) return '-';
  if (position.kind === 'page') return `p${position.page}:${position.scroll === undefined ? 't' : position.scroll.toFixed(4)}`;
  return `c${position.cfi}`;
}

export const roundScroll = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
