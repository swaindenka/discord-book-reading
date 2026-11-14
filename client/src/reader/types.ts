import type {
  BookHighlight,
  BookInfo,
  HighlightAnchor,
  HighlightColor,
  PointerEvent,
  Position,
  SelectionCue,
} from '../../../shared/types';

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
  goToHighlight?(highlight: BookHighlight): void;
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
  /** You control the room's page, so your pointer and EPUB selection are shared. */
  canSend: boolean;
  pointer: PointerEvent | null;
  selection: SelectionCue | null;
  pointerName: string;
  sendPointer(page: number, x: number | null, y: number | null): void;
  sendSelection(cfiRange: string | null): void;
}

export interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the user just selected in the book. */
export interface SelectionInfo {
  text: string;
  /** Viewport coordinates, for placing the pop-over. */
  rect: SelectionRect;
  /** Where a highlight of this selection would go; null if it can't be highlighted. */
  anchor: HighlightAnchor | null;
  label: string;
  /** Clears the selection in the book. */
  clear(): void;
}

export interface HighlightProps {
  /** Highlights of this book (empty when hidden). */
  items: BookHighlight[];
  /** Moderators only: highlighter mode is on (area drawing for PDF/comic pages). */
  drawing: boolean;
  color: HighlightColor;
  create(anchor: HighlightAnchor, text: string, label: string): void;
  /** Moderators only: a saved highlight was clicked (opens its remove menu). */
  onClick?(id: string, rect: SelectionRect): void;
}

export interface ReaderProps {
  book: BookInfo;
  data: ArrayBuffer;
  target: ReaderTarget;
  prefs: ReaderPrefs;
  onNavigate(event: NavigateEvent): void;
  onMeta(meta: ReaderMeta): void;
  onError(message: string): void;
  /** Called when the user finishes selecting text (null when the selection goes away). */
  onSelection(info: SelectionInfo | null): void;
  cues: CueProps;
  highlights: HighlightProps;
}

export function positionKey(position: Position | null | undefined): string {
  if (!position) return '-';
  if (position.kind === 'page') return `p${position.page}:${position.scroll === undefined ? 't' : position.scroll.toFixed(4)}`;
  return `c${position.cfi}`;
}

export const roundScroll = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
