import { useRef, useState } from 'react';
import { LIMITS } from '../../../shared/types';
import { parseBookFilename, type BookName } from '../../../shared/bookname';
import { readBookInfo } from '../bookInfo';

/** Title and author fields for an upload, pre-filled from the file's metadata or name. */
export function useBookDetails() {
  const [title, setTitleState] = useState('');
  const [author, setAuthorState] = useState('');
  const [reading, setReading] = useState(false);
  const token = useRef(0);
  const touched = useRef({ title: false, author: false });

  const setTitle = (value: string) => {
    touched.current.title = true;
    setTitleState(value);
  };
  const setAuthor = (value: string) => {
    touched.current.author = true;
    setAuthorState(value);
  };

  /** Fills in the fields for a newly chosen file; resolves with the best guess. */
  const load = async (file: File | null): Promise<BookName | null> => {
    const current = ++token.current;
    touched.current = { title: false, author: false };
    if (!file) {
      setTitleState('');
      setAuthorState('');
      return null;
    }
    const quick = parseBookFilename(file.name);
    setTitleState(quick.title);
    setAuthorState(quick.author ?? '');
    setReading(true);
    try {
      const info = await readBookInfo(file);
      if (current !== token.current) return null;
      if (!touched.current.title) setTitleState(info.title);
      if (!touched.current.author) setAuthorState(info.author ?? '');
      return info;
    } finally {
      if (current === token.current) setReading(false);
    }
  };

  return { title, author, setTitle, setAuthor, reading, load };
}

export type BookDetails = ReturnType<typeof useBookDetails>;

export function BookFields({ details }: { details: BookDetails }) {
  return (
    <div className="field-row">
      <label className="field">
        <span>Book title</span>
        <input
          className="input"
          value={details.title}
          maxLength={LIMITS.bookTitle}
          required
          onChange={(e) => details.setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        <span>
          Author <span className="muted">(optional)</span>
        </span>
        <input
          className="input"
          value={details.author}
          maxLength={LIMITS.bookAuthor}
          placeholder={details.reading ? 'Reading the book…' : ''}
          onChange={(e) => details.setAuthor(e.target.value)}
        />
      </label>
    </div>
  );
}
