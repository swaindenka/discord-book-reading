import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import JSZip from 'jszip';
import { pageBoxes, PointerSurface, useElementSize, usePagedSync } from './paged';
import type { ReaderHandle, ReaderProps } from './types';
import { Spinner } from '../components/ui';
import { cx } from '../util';

const IMAGE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
// The scroll container's content box (padding excluded) is the space a page can use.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const ComicReader = forwardRef<ReaderHandle, ReaderProps>(function ComicReader(
  { book, data, target, prefs, onNavigate, onMeta, onError, cues, highlights },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<JSZip.JSZipObject[] | null>(null);
  const urls = useRef(new Map<number, Promise<string>>());
  const [src, setSrc] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const size = useElementSize(scrollRef);
  const pageCount = entries?.length ?? 0;
  const { page, goToPage, markRendered, onScroll } = usePagedSync({ pageCount, target, onNavigate, scrollRef });

  useImperativeHandle(
    ref,
    () => ({
      next: () => goToPage(page + 1),
      prev: () => goToPage(page - 1),
      goToPage,
      goToHighlight: (h) => {
        if (h.anchor.kind === 'rects') goToPage(h.anchor.page, h.anchor.rects[0]?.[1]);
      },
    }),
    [goToPage, page],
  );

  useEffect(() => {
    let alive = true;
    const cache = urls.current;
    JSZip.loadAsync(data)
      .then((zip) => {
        if (!alive) return;
        const images = Object.values(zip.files)
          .filter((f) => !f.dir && IMAGE.test(f.name) && !/(^|\/)(__MACOSX|\.)/.test(f.name))
          .sort((a, b) => collator.compare(a.name, b.name));
        if (images.length === 0) onError('This comic archive contains no images.');
        setEntries(images);
      })
      .catch(() => alive && onError('Could not open this CBZ file.'));
    return () => {
      alive = false;
      for (const url of cache.values()) void url.then(URL.revokeObjectURL);
      cache.clear();
    };
  }, [data, onError]);

  const urlFor = (index: number) => {
    if (!entries || index < 1 || index > entries.length) return null;
    let url = urls.current.get(index);
    if (!url) {
      url = entries[index - 1].async('blob').then((blob) => URL.createObjectURL(blob));
      urls.current.set(index, url);
    }
    return url;
  };

  useEffect(() => {
    if (!entries) return;
    let alive = true;
    urlFor(page)?.then((url) => alive && setSrc(url));
    urlFor(page + 1); // preload the next page
    // Free pages that are far away.
    for (const [index, url] of urls.current) {
      if (Math.abs(index - page) > 4) {
        void url.then(URL.revokeObjectURL);
        urls.current.delete(index);
      }
    }
    onMeta({ label: `Page ${page} of ${entries.length}`, page, pageCount: entries.length });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, page]);

  let display: { width: number; height: number } | null = null;
  if (natural && size.width) {
    const availW = Math.max(100, size.width);
    const availH = Math.max(100, size.height);
    const fit = prefs.fit === 'page' ? Math.min(availW / natural.width, availH / natural.height) : availW / natural.width;
    const scale = fit * prefs.zoom;
    display = { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
  }

  useEffect(() => {
    if (display) requestAnimationFrame(() => markRendered(page));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display?.width, display?.height, src]);

  return (
    <div className={cx('paged-scroll', `page-theme-${prefs.theme}`)} ref={scrollRef} onScroll={onScroll}>
      {!src && <Spinner label="Opening comic…" />}
      {src && (
        <PointerSurface
          page={page}
          cues={cues}
          bookId={book.id}
          className="comic-page"
          style={display ?? undefined}
          highlights={pageBoxes(highlights.items, page)}
          draw={{
            enabled: highlights.drawing,
            color: highlights.color,
            onDone: (box) => highlights.create({ kind: 'rects', page, rects: [box] }, '', `Page ${page}`),
          }}
        >
          <img
            src={src}
            alt={`Page ${page}`}
            draggable={false}
            onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            style={display ?? { visibility: 'hidden' }}
          />
        </PointerSurface>
      )}
    </div>
  );
});
