import JSZip from 'jszip';
import { cleanTitle, isUsableMetadataTitle, parseBookFilename, type BookName } from '../../shared/bookname';
import { formatFromFilename } from '../../shared/types';

const METADATA_LIMIT = 80 * 1024 * 1024;

async function epubMetadata(file: File): Promise<Partial<BookName>> {
  const zip = await JSZip.loadAsync(file);
  const container = await zip.file('META-INF/container.xml')?.async('text');
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  const opf = opfPath ? await zip.file(opfPath)?.async('text') : undefined;
  if (!opf) return {};
  const doc = new DOMParser().parseFromString(opf, 'application/xml');
  const pick = (tag: string) => doc.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() || null;
  return { title: pick('title') ?? undefined, author: pick('creator') };
}

async function pdfMetadata(file: File): Promise<Partial<BookName>> {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableAutoFetch: true });
  try {
    const doc = await task.promise;
    const { info, metadata } = (await doc.getMetadata()) as {
      info: { Title?: string; Author?: string };
      metadata: { get(name: string): string | null } | null;
    };
    return {
      title: metadata?.get('dc:title') || info?.Title || undefined,
      author: metadata?.get('dc:creator') || info?.Author || null,
    };
  } finally {
    void task.destroy();
  }
}

/**
 * Suggests a title and author for an upload: the book's own metadata when it looks
 * trustworthy, otherwise a cleaned-up file name.
 */
export async function readBookInfo(file: File): Promise<BookName> {
  const fromName = parseBookFilename(file.name);
  let meta: Partial<BookName> = {};
  try {
    const format = formatFromFilename(file.name);
    if (file.size <= METADATA_LIMIT) {
      if (format === 'epub') meta = await epubMetadata(file);
      else if (format === 'pdf') meta = await pdfMetadata(file);
    }
  } catch {
    /* unreadable metadata: fall back to the file name */
  }
  const author = meta.author?.replace(/\s+/g, ' ').trim();
  return {
    title: isUsableMetadataTitle(meta.title) ? cleanTitle(meta.title) : fromName.title,
    author: author && author.length <= 100 && !/^(unknown|anonymous|admin|user)$/i.test(author) ? author : fromName.author,
  };
}
