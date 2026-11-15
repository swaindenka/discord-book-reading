import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, CalendarClock, Mic, Plus, RefreshCw, Users } from 'lucide-react';
import type { RoomSummary } from '../../../shared/types';
import { BOOK_FORMATS, LIMITS, formatFromFilename } from '../../../shared/types';
import { api } from '../api';
import { AppHeader } from '../components/AppHeader';
import { Avatar, FileDrop, Modal, ProgressBar, Spinner } from '../components/ui';
import { BookFields, useBookDetails } from '../components/BookFields';
import { parseBookFilename } from '../../../shared/bookname';
import { useToast } from '../components/Toasts';
import { Link, navigate, useDocumentTitle } from '../router';
import { progressFraction, progressLabel } from '../util';
import { formatSession, isUpcoming } from '../schedule';
import { useSession } from '../session';

function CreateRoomDialog({ onClose }: { onClose: () => void }) {
  const { config } = useSession();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const details = useBookDetails();
  const nameTouched = useRef(false);
  const [progress, setProgress] = useState<number | null>(null);

  const chooseFile = (next: File | null) => {
    if (next && !formatFromFilename(next.name)) {
      toast.show('That file type is not supported. Use PDF, EPUB, TXT, Markdown or CBZ.', 'error');
      return;
    }
    if (next && next.size > config.maxUploadMb * 1024 * 1024) {
      toast.show(`That file is larger than ${config.maxUploadMb} MB.`, 'error');
      return;
    }
    setFile(next);
    // Suggest the book's title as the room name until the user types their own.
    if (next && !nameTouched.current) setName(parseBookFilename(next.name).title.slice(0, LIMITS.roomName));
    void details.load(next).then((info) => {
      if (info && !nameTouched.current) setName(info.title.slice(0, LIMITS.roomName));
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const form = new FormData();
    form.set('name', name);
    form.set('description', description);
    if (file) {
      form.set('title', details.title);
      form.set('author', details.author);
      form.set('file', file);
    }
    setProgress(0);
    try {
      const { id } = await api.createRoom(form, setProgress);
      navigate(`/room/${id}`);
    } catch (err) {
      toast.error(err);
      setProgress(null);
    }
  };

  const busy = progress !== null;
  return (
    <Modal title="Start a reading room" onClose={busy ? () => {} : onClose}>
      <form className="form" onSubmit={submit}>
        <FileDrop file={file} onFile={chooseFile} maxMb={config.maxUploadMb} />
        {file && <BookFields details={details} />}
        <label className="field">
          <span>Room name</span>
          <input
            className="input"
            value={name}
            required
            maxLength={LIMITS.roomName}
            placeholder="Friday night book club"
            onChange={(e) => {
              nameTouched.current = true;
              setName(e.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>
            Description <span className="muted">(optional)</span>
          </span>
          <textarea
            className="input"
            rows={2}
            value={description}
            maxLength={LIMITS.roomDescription}
            placeholder="What are we reading, and when?"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <p className="muted small">
          You'll be the room's moderator: you can reorder the queue, skip readers and manage the library. You can add more
          books later.
        </p>
        {busy && <ProgressBar value={progress} />}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {busy ? (progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Creating…') : 'Create room'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RoomCard({ room }: { room: RoomSummary }) {
  const live = room.online.length > 0;
  return (
    <Link href={`/room/${room.id}`} className="room-card">
      <div className="room-card-top">
        <span className={`format-chip format-${room.bookFormat ?? 'none'}`}>
          {room.bookFormat ? BOOK_FORMATS[room.bookFormat].short : 'No book'}
        </span>
        {live && (
          <span className="live-chip">
            <span className="live-dot" /> {room.online.length} here
          </span>
        )}
      </div>
      <h3 className="clamp-2">{room.name}</h3>
      {room.bookTitle && (
        <div className="room-card-book">
          <BookOpen size={14} aria-hidden />
          <span>
            {/* Don't repeat the title when the room is named after the book. */}
            {room.bookTitle.toLowerCase() !== room.name.toLowerCase() && <span className="clamp-2">{room.bookTitle}</span>}
            <span className="muted">
              {[room.bookAuthor, progressLabel(room.bookPosition, room.bookPageCount) && `at ${progressLabel(room.bookPosition, room.bookPageCount)}`, room.bookCount > 1 && `+${room.bookCount - 1} more`]
                .filter(Boolean)
                .join(' · ') || 'Not started yet'}
            </span>
          </span>
        </div>
      )}
      {room.description && <p className="muted small clamp-2">{room.description}</p>}
      {isUpcoming(room.nextSessionAt) && (
        <p className="room-card-session small">
          <CalendarClock size={13} aria-hidden /> Next: {formatSession(room.nextSessionAt)}
        </p>
      )}
      {progressFraction(room.bookPosition, room.bookPageCount) !== null && (
        <div className="mini-progress" aria-hidden>
          <div style={{ width: `${progressFraction(room.bookPosition, room.bookPageCount)! * 100}%` }} />
        </div>
      )}
      <div className="room-card-footer">
        {room.readerName ? (
          <span className="small">
            <Mic size={13} aria-hidden /> {room.readerName} is reading
          </span>
        ) : (
          <span className="muted small">Hosted by {room.ownerName}</span>
        )}
        <span className="avatar-stack">
          {room.online.slice(0, 5).map((m, i) => (
            <Avatar key={i} id={m.name + i} name={m.name} url={m.avatarUrl} size={22} />
          ))}
        </span>
      </div>
    </Link>
  );
}

export function HomePage() {
  const { config, user } = useSession();
  const toast = useToast();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  useDocumentTitle(config.appName);

  const load = useCallback(() => {
    api
      .rooms()
      .then((r) => setRooms(r.rooms))
      .catch((err) => {
        toast.error(err);
        setRooms((prev) => prev ?? []);
      });
  }, [toast]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="page">
      <AppHeader />
      <main className="home">
        <section className="home-hero">
          <div>
            <h1>Welcome back, {user?.name.split(' ')[0]}</h1>
            <p className="muted">
              Join a room to follow along, hop in the queue when you want to read, and keep the voice chat on Discord.
            </p>
          </div>
          <div className="row">
            <button className="btn ghost" onClick={load} aria-label="Refresh rooms" title="Refresh">
              <RefreshCw size={16} />
            </button>
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={18} /> New room
            </button>
          </div>
        </section>

        {rooms === null ? (
          <Spinner label="Loading rooms…" />
        ) : rooms.length === 0 ? (
          <div className="empty-state">
            <Users size={36} aria-hidden />
            <h2>No reading rooms yet</h2>
            <p className="muted">Create one, upload a book, and share the link in your Discord server.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={18} /> Create the first room
            </button>
          </div>
        ) : (
          <div className="room-grid">
            {rooms.map((room) => (
              <RoomCard key={room.id} room={room} />
            ))}
          </div>
        )}
      </main>
      {creating && <CreateRoomDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
