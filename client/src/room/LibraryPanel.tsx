import { useState, type FormEvent } from 'react';
import { BookOpen, BookOpenCheck, Pencil, Trash2 } from 'lucide-react';
import type { BookInfo, RoomState } from '../../../shared/types';
import { BOOK_FORMATS, LIMITS, formatFromFilename } from '../../../shared/types';
import { api } from '../api';
import { FileDrop, ProgressBar } from '../components/ui';
import { BookFields, useBookDetails } from '../components/BookFields';
import { useToast } from '../components/Toasts';
import { useSession } from '../session';
import { cx, formatBytes, progressFraction, progressLabel } from '../util';
import type { RoomPerspective } from './common';
import type { RoomApi } from './useRoom';

function progressText(book: BookInfo) {
  const p = book.position;
  if (!p) return book.pageCount ? `Not started · ${book.pageCount} pages` : 'Not started';
  if (p.kind === 'page') return `Stopped at ${progressLabel(p, book.pageCount)}`;
  return [p.label, p.percent !== undefined && `${Math.round(p.percent)}%`].filter(Boolean).join(' · ') || 'In progress';
}

/** Inline editor for a book's title and author (moderators). */
function EditBookForm({ book, room, onDone }: { book: BookInfo; room: RoomApi; onDone: () => void }) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await room.actions.moderate({ type: 'book.update', bookId: book.id, title, author });
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <form className="form edit-book" onSubmit={save}>
      <label className="field">
        <span>Title</span>
        <input className="input" value={title} required maxLength={LIMITS.bookTitle} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>
          Author <span className="muted">(optional)</span>
        </span>
        <input className="input" value={author} maxLength={LIMITS.bookAuthor} onChange={(e) => setAuthor(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn small ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn small primary" disabled={busy || !title.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

function UploadForm({ roomId }: { roomId: string }) {
  const { config } = useSession();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const details = useBookDetails();
  const [progress, setProgress] = useState<number | null>(null);

  const choose = (next: File | null) => {
    if (next && !formatFromFilename(next.name)) {
      toast.show('Unsupported file type. Use PDF, EPUB, MOBI, AZW3, TXT, Markdown or CBZ.', 'error');
      return;
    }
    if (next && next.size > config.maxUploadMb * 1024 * 1024) {
      toast.show(`That file is larger than ${config.maxUploadMb} MB.`, 'error');
      return;
    }
    setFile(next);
    void details.load(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.set('title', details.title);
    form.set('author', details.author);
    form.set('file', file);
    setProgress(0);
    try {
      await api.uploadBook(roomId, form, setProgress);
      toast.show('Book added to the library.', 'success');
      setFile(null);
      void details.load(null);
    } catch (err) {
      toast.error(err);
    } finally {
      setProgress(null);
    }
  };

  return (
    <form className="form upload-form" onSubmit={submit}>
      <FileDrop file={file} onFile={choose} maxMb={config.maxUploadMb} />
      {file && (
        <>
          <BookFields details={details} />
          {progress !== null && <ProgressBar value={progress} />}
          <button className="btn primary" disabled={progress !== null}>
            {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Upload book'}
          </button>
        </>
      )}
    </form>
  );
}

export function LibraryPanel({ state, view, room }: { state: RoomState; view: RoomPerspective; room: RoomApi }) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const remove = async (book: BookInfo) => {
    if (!window.confirm(`Delete “${book.title}” from this room? Its reading progress is lost.`)) return;
    try {
      await api.deleteBook(state.id, book.id);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h3 className="section-title">
          Library <span className="count">{state.books.length}</span>
        </h3>
        {state.books.length === 0 && <p className="muted small">No books yet.</p>}
        <ul className="book-list">
          {state.books.map((book) => {
            const active = book.id === state.activeBookId;
            if (editing === book.id) {
              return (
                <li key={book.id} className="book-row editing">
                  <EditBookForm book={book} room={room} onDone={() => setEditing(null)} />
                </li>
              );
            }
            return (
              <li key={book.id} className={cx('book-row', active && 'active')}>
                <div className="book-row-text">
                  <span className={`format-chip format-${book.format}`}>{BOOK_FORMATS[book.format].short}</span>
                  <strong className="clamp-2">{book.title}</strong>
                  {book.author && <span className="small">{book.author}</span>}
                  <span className="muted small">
                    {progressText(book)} · {formatBytes(book.size)}
                  </span>
                  {progressFraction(book.position, book.pageCount) !== null && (
                    <div className="mini-progress" aria-hidden>
                      <div style={{ width: `${progressFraction(book.position, book.pageCount)! * 100}%` }} />
                    </div>
                  )}
                  <span className="muted small">Added by {book.uploadedByName}</span>
                </div>
                <div className="book-row-actions">
                  {active ? (
                    <span className="pill small success" title="Everyone is reading this book">
                      <BookOpenCheck size={12} /> Open
                    </span>
                  ) : (
                    view.isMod && (
                      <button
                        className="btn small"
                        onClick={() => room.actions.moderate({ type: 'book.activate', bookId: book.id })}
                        title="Open this book for everyone"
                      >
                        <BookOpen size={14} /> Open
                      </button>
                    )
                  )}
                  {view.isMod && (
                    <button
                      className="icon-btn ghost"
                      aria-label={`Edit details of ${book.title}`}
                      title="Edit title and author"
                      onClick={() => setEditing(book.id)}
                    >
                      <Pencil size={15} />
                    </button>
                  )}
                  {view.isMod && (
                    <button className="icon-btn ghost" aria-label={`Delete ${book.title}`} title="Delete book" onClick={() => remove(book)}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      {view.isMod ? (
        <section className="panel-section">
          <h3 className="section-title">Add a book</h3>
          <UploadForm roomId={state.id} />
        </section>
      ) : (
        <p className="muted small panel-section">Moderators can add books and choose which one is open.</p>
      )}
    </div>
  );
}
