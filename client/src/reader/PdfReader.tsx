import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pageBoxes, PointerSurface, useElementSize, usePagedSync } from './paged';
import { clearDomSelection, rangeToPageRects, rectOf, useSelectionWatcher } from './selection';
import type { ReaderHandle, ReaderProps, TocItem } from './types';
import { Spinner } from '../components/ui';
import { cx } from '../util';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// The scroll container's content box (padding excluded) is the space a page can use.

type OutlineNode = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number];

async function resolveOutline(doc: PDFDocumentProxy): Promise<TocItem[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline) return [];
  const items: TocItem[] = [];
  const walk = async (nodes: OutlineNode[], depth: number) => {
    for (const node of nodes) {
      let page: number | undefined;
      try {
        const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
        const ref = dest?.[0];
        if (ref && typeof ref === 'object') page = (await doc.getPageIndex(ref as never)) + 1;
        else if (typeof ref === 'number') page = ref + 1;
      } catch {
        /* unresolvable destination */
      }
      if (page) items.push({ label: node.title || `Page ${page}`, depth, page });
      if (node.items?.length && items.length < 500) await walk(node.items, depth + 1);
    }
  };
  await walk(outline, 0);
  return items;
}

export const PdfReader = forwardRef<ReaderHandle, ReaderProps>(function PdfReader(
  { book, data, src, target, prefs, onNavigate, onMeta, onError, onSelection, cues, highlights },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [loadProgress, setLoadProgress] = useState(0);
  const size = useElementSize(scrollRef);
  const pageCount = doc?.numPages ?? 0;
  const { page, goToPage, markRendered, onScroll } = usePagedSync({ pageCount, target, onNavigate, scrollRef });

  useImperativeHandle(
    ref,
    () => ({
      next: () => goToPage(page + 1),
      prev: () => goToPage(page - 1),
      goToPage,
      goToToc: (item) => item.page && goToPage(item.page),
      goToHighlight: (h) => {
        if (h.anchor.kind === 'rects') goToPage(h.anchor.page, h.anchor.rects[0]?.[1]);
      },
    }),
    [goToPage, page],
  );

  // Text selected on the page: offer a dictionary look-up or a highlight.
  useSelectionWatcher(pageRef, (range) => {
    const surface = pageRef.current;
    if (!range || !surface) return onSelection(null);
    const rects = rangeToPageRects(range, surface);
    onSelection({
      text: range.toString(),
      rect: rectOf(range),
      anchor: rects.length ? { kind: 'rects', page, rects } : null,
      label: `Page ${page}`,
      clear: clearDomSelection,
    });
  });

  // Load the document. pdf.js takes ownership of the buffer, so hand it a copy.
  useEffect(() => {
    const source = data.byteLength
      ? { data: new Uint8Array(data.slice(0)) }
      : // Stream: only the parts of the file needed for the current page are downloaded.
        { url: src, withCredentials: true, rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: true };
    const task = pdfjs.getDocument({
      ...source,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      iccUrl: '/pdfjs/iccs/',
      enableXfa: false,
    });
    let alive = true;
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (alive && total) setLoadProgress(Math.min(1, loaded / total));
    };
    task.promise.then(
      (loaded) => {
        if (!alive) return;
        setDoc(loaded);
        resolveOutline(loaded).then((items) => alive && setToc(items));
      },
      (err: Error) => alive && onError(`Could not open this PDF: ${err.message}`),
    );
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [data, src, onError]);

  useEffect(() => {
    if (pageCount) onMeta({ label: `Page ${page} of ${pageCount}`, page, pageCount, toc });
  }, [page, pageCount, toc, onMeta]);

  // Height only matters when fitting the whole page; ignoring it otherwise avoids
  // re-rendering (and losing a text selection) when the toolbar changes height.
  const fitHeight = prefs.fit === 'page' ? size.height : 1;

  // Render the current page whenever it, the window size or zoom changes.
  useEffect(() => {
    if (!doc || !size.width || !fitHeight) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    (async () => {
      const pdfPage = await doc.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const availW = Math.max(100, size.width);
      const availH = Math.max(100, fitHeight);
      const fitScale = prefs.fit === 'page' ? Math.min(availW / base.width, availH / base.height) : availW / base.width;
      const scale = Math.min(8, fitScale * prefs.zoom);
      const viewport = pdfPage.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      renderTask = pdfPage.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      await renderTask.promise;
      if (cancelled) return;
      canvasHost.current?.replaceChildren(canvas);
      setPageSize({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) });

      const layer = textLayerRef.current;
      if (layer) {
        layer.replaceChildren();
        layer.style.setProperty('--scale-factor', String(scale));
        layer.style.setProperty('--total-scale-factor', String(scale));
        textLayer = new pdfjs.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layer, viewport });
        await textLayer.render().catch(() => {});
      }
      if (!cancelled) requestAnimationFrame(() => markRendered(page));
    })().catch((err: Error) => {
      if (!cancelled && err?.name !== 'RenderingCancelledException') console.warn('PDF render failed', err);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, page, size.width, fitHeight, prefs.fit, prefs.zoom, markRendered]);

  return (
    <div className={cx('paged-scroll', `page-theme-${prefs.theme}`)} ref={scrollRef} onScroll={onScroll}>
      {!doc && <Spinner label={loadProgress ? `Opening PDF… ${Math.round(loadProgress * 100)}%` : 'Opening PDF…'} />}
      <PointerSurface
        page={page}
        cues={cues}
        bookId={book.id}
        surfaceRef={pageRef}
        className={cx('pdf-page', !pageSize && 'hidden')}
        style={pageSize ? { width: pageSize.width, height: pageSize.height } : undefined}
        highlights={pageBoxes(highlights.items, page)}
        onHighlightClick={highlights.onClick}
        draw={{
          enabled: highlights.drawing,
          color: highlights.color,
          // Drags that start on text select it; drags on empty space draw a box (works for scanned pages).
          canStart: (el) => !(el instanceof HTMLElement && el.closest('.textLayer span')),
          onDone: (box) => highlights.create({ kind: 'rects', page, rects: [box] }, '', `Page ${page}`),
        }}
      >
        <div className="pdf-canvas" ref={canvasHost} />
        <div className="textLayer" ref={textLayerRef} />
      </PointerSurface>
    </div>
  );
});
