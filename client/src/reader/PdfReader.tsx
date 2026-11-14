import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PointerSurface, useElementSize, usePagedSync } from './paged';
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
  { book, data, target, prefs, onNavigate, onMeta, onError, cues },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
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
    }),
    [goToPage, page],
  );

  // Load the document. pdf.js takes ownership of the buffer, so hand it a copy.
  useEffect(() => {
    const task = pdfjs.getDocument({
      data: new Uint8Array(data.slice(0)),
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      iccUrl: '/pdfjs/iccs/',
      enableXfa: false,
    });
    let alive = true;
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
  }, [data, onError]);

  useEffect(() => {
    if (pageCount) onMeta({ label: `Page ${page} of ${pageCount}`, page, pageCount, toc });
  }, [page, pageCount, toc, onMeta]);

  // Render the current page whenever it, the window size or zoom changes.
  useEffect(() => {
    if (!doc || !size.width || !size.height) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    (async () => {
      const pdfPage = await doc.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const availW = Math.max(100, size.width);
      const availH = Math.max(100, size.height);
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
  }, [doc, page, size.width, size.height, prefs.fit, prefs.zoom, markRendered]);

  return (
    <div className={cx('paged-scroll', `page-theme-${prefs.theme}`)} ref={scrollRef} onScroll={onScroll}>
      {!doc && <Spinner label="Opening PDF…" />}
      <PointerSurface
        page={page}
        cues={cues}
        bookId={book.id}
        className={cx('pdf-page', !pageSize && 'hidden')}
        style={pageSize ? { width: pageSize.width, height: pageSize.height } : undefined}
      >
        <div className="pdf-canvas" ref={canvasHost} />
        <div className="textLayer" ref={textLayerRef} />
      </PointerSurface>
    </div>
  );
});
