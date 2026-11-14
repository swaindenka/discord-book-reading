import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BookOpen, Mic, Plus, RefreshCw, Users } from 'lucide-react';
import type { RoomSummary } from '../../../shared/types';
import { BOOK_FORMATS, LIMITS, formatFromFilename } from '../../../shared/types';
import { api } from '../api';
import { AppHeader } from '../components/AppHeader';
import { Avatar, FileDrop, Modal, ProgressBar, Spinner } from '../components/ui';
import { useToast } from '../components/Toasts';
import { Link, navigate, useDocumentTitle } from '../router';
import { useSession } from '../session';

function titleFromFile(file: File) {
  return file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .trim();
}

function CreateRoomDialog({ onClose }: { onClose: () => void }) {
  const { config } = useSession();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
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
    if (next) {
      setTitle(titleFromFile(next));
      if (!name) setName(titleFromFile(next).slice(0, LIMITS.roomName));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const form = new FormData();
    form.set('name', name);
    form.set('description', description);
    if (file) {
      form.set('title', title);
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
        {file && (
          <label className="field">
            <span>Book title</span>
            <input className="input" value={title} maxLength={LIMITS.bookTitle} onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Room name</span>
          <input
            className="input"
            value={name}
            required
            maxLength={LIMITS.roomName}
            placeholder="Friday night book club"
            onChange={(e) => setName(e.target.value)}
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
      <h3>{room.name}</h3>
      {room.bookTitle && (
        <p className="room-card-book">
          <BookOpen size={14} aria-hidden /> {room.bookTitle}
          {room.bookCount > 1 && <span className="muted"> · +{room.bookCount - 1} more</span>}
        </p>
      )}
      {room.description && <p className="muted small clamp-2">{room.description}</p>}
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
