import { useEffect, useRef, type RefObject } from 'react';
import type { SelectionRect } from './types';

/**
 * Watches text selection inside `container` and reports once the user finishes
 * selecting (mouse up, or a pause for touch/keyboard selection). Reports null
 * when the selection is cleared.
 */
export function useSelectionWatcher(
  containerRef: RefObject<HTMLElement | null>,
  onFinish: (range: Range | null) => void,
) {
  const callback = useRef(onFinish);
  callback.current = onFinish;

  useEffect(() => {
    let pointerDown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The selection we last reported, so unrelated selectionchange events don't re-open the pop-over. */
    let reported: { node: Node; offset: number; text: string } | null = null;

    const check = () => {
      const container = containerRef.current;
      const selection = window.getSelection();
      if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        if (reported) {
          reported = null;
          callback.current(null);
        }
        return;
      }
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;
      const text = range.toString();
      if (!text.trim()) return;
      if (reported && reported.node === range.startContainer && reported.offset === range.startOffset && reported.text === text) {
        return;
      }
      reported = { node: range.startContainer, offset: range.startOffset, text };
      callback.current(range);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current?.contains(e.target as Node)) pointerDown = true;
    };
    const onPointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      setTimeout(check, 0);
    };
    const onSelectionChange = () => {
      clearTimeout(timer);
      if (pointerDown) return;
      timer = setTimeout(check, 450);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [containerRef]);
}

export function rectOf(range: Range, offset = { x: 0, y: 0 }): SelectionRect {
  const r = range.getBoundingClientRect();
  return { left: r.left + offset.x, top: r.top + offset.y, right: r.right + offset.x, bottom: r.bottom + offset.y };
}

export function clearDomSelection() {
  window.getSelection()?.removeAllRanges();
}

/**
 * Converts a selection on a page into boxes relative to the page (0–1), merging the
 * pieces of each line so a highlight is a few tidy bars rather than one box per word.
 */
export function rangeToPageRects(range: Range, page: HTMLElement): [number, number, number, number][] {
  const box = page.getBoundingClientRect();
  if (!box.width || !box.height) return [];
  const pieces = Array.from(range.getClientRects())
    .filter((r) => r.width > 1 && r.height > 1 && r.height < box.height * 0.2)
    .map((r) => ({
      x: (r.left - box.left) / box.width,
      y: (r.top - box.top) / box.height,
      w: r.width / box.width,
      h: r.height / box.height,
    }))
    .filter((r) => r.x < 1 && r.y < 1 && r.x + r.w > 0 && r.y + r.h > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const lines: typeof pieces = [];
  for (const piece of pieces) {
    const line = lines.find((l) => Math.abs(l.y + l.h / 2 - (piece.y + piece.h / 2)) < Math.min(l.h, piece.h) / 2);
    if (line && piece.x <= line.x + line.w + 0.02 && piece.x + piece.w >= line.x - 0.02) {
      const right = Math.max(line.x + line.w, piece.x + piece.w);
      const bottom = Math.max(line.y + line.h, piece.y + piece.h);
      line.x = Math.min(line.x, piece.x);
      line.y = Math.min(line.y, piece.y);
      line.w = right - line.x;
      line.h = bottom - line.y;
    } else {
      lines.push({ ...piece });
    }
  }
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return lines.slice(0, 200).map((l) => {
    const x = clamp(l.x);
    const y = clamp(l.y);
    return [x, y, clamp(l.x + l.w) - x, clamp(l.y + l.h) - y].map((n) => Math.round(n * 10000) / 10000) as [
      number,
      number,
      number,
      number,
    ];
  });
}

/** Character offsets of a range within `root`'s text. */
export function textOffsets(root: Node, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const end = start + range.toString().length;
  return end > start ? { start, end } : null;
}

/** Rebuilds a DOM range from character offsets within `root`. */
export function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let position = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.data.length;
    if (!startNode && start < position + length) {
      startNode = node;
      startOffset = start - position;
    }
    if (startNode && end <= position + length) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(node, end - position);
      return range;
    }
    position += length;
  }
  return null;
}
