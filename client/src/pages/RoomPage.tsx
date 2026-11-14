import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Eye,
  LibraryBig,
  ListOrdered,
  LocateFixed,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  Settings,
  Users,
  WifiOff,
} from 'lucide-react';
import type { Position } from '../../../shared/types';
import { UserMenu } from '../components/AppHeader';
import { Spinner } from '../components/ui';
import { useToast } from '../components/Toasts';
import { BookViewer, type ViewerHighlights } from '../reader/BookViewer';
import type { CueProps, NavigateEvent, ReaderTarget } from '../reader/types';
import { ChatPanel } from '../room/ChatPanel';
import { LibraryPanel } from '../room/LibraryPanel';
import { QueuePanel } from '../room/QueuePanel';
import { SettingsPanel, usePersonalPrefs } from '../room/SettingsPanel';
import { TurnBar } from '../room/TurnBar';
import { perspective } from '../room/common';
import { useRoom } from '../room/useRoom';
import { Link, useDocumentTitle } from '../router';
import { useSession } from '../session';
import { cx, loadPref, playChime, savePref } from '../util';

type Tab = 'queue' | 'chat' | 'library' | 'settings';

const TABS: { id: Tab; label: string; Icon: typeof Users }[] = [
  { id: 'queue', label: 'Queue', Icon: ListOrdered },
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'library', label: 'Library', Icon: LibraryBig },
  { id: 'settings', label: 'Room', Icon: Settings },
];

function ExitScreen({ title, body }: { title: string; body: string }) {
  return (
    <div className="center-screen">
      <div className="card narrow">
        <h1>{title}</h1>
        <p className="muted">{body}</p>
        <Link className="btn primary" href="/">
          <ArrowLeft size={16} /> Back to rooms
        </Link>
      </div>
    </div>
  );
}

export function RoomPage({ roomId }: { roomId: string }) {
  const { user, config } = useSession();
  const toast = useToast();
  const room = useRoom(roomId);
  const { state } = room;
  const [tab, setTabState] = useState<Tab>(() => loadPref<{ tab: Tab }>('tab', { tab: 'queue' }).tab);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 960px)').matches);
  const [unread, setUnread] = useState(0);
  const [personal, updatePersonal] = usePersonalPrefs();
  const [following, setFollowing] = useState(true);
  const [localPosition, setLocalPosition] = useState<Position | null>(null);
  const [version, setVersion] = useState(0);

  const setTab = (next: Tab) => {
    setTabState(next);
    savePref('tab', { tab: next });
    if (next === 'chat') setUnread(0);
  };

  const view = state && user ? perspective(state, user) : null;
  const activeBook = state?.books.find((b) => b.id === state.activeBookId) ?? null;
  const controller = Boolean(view && (view.isReader || (view.isMod && !state?.reader)));

  useDocumentTitle(
    state ? `${view?.isReader ? '📖 Your turn · ' : ''}${state.name} · ${config.appName}` : config.appName,
  );

  // Becoming (or no longer being) the page-turner, or switching books, snaps back to the group.
  useEffect(() => {
    setFollowing(true);
    setLocalPosition(null);
    setVersion((v) => v + 1);
  }, [controller, state?.activeBookId]);

  // Count unread chat messages while the chat is hidden.
  const seenMessages = useRef(0);
  useEffect(() => {
    const count = room.messages.length;
    const fresh = room.messages.slice(seenMessages.current).filter((m) => m.kind === 'user' && m.userId !== user?.id).length;
    seenMessages.current = count;
    if (fresh && (tab !== 'chat' || !sidebarOpen)) setUnread((n) => n + fresh);
  }, [room.messages, tab, sidebarOpen, user?.id]);

  // Turn alerts.
  const previousReader = useRef<string | null | undefined>(undefined);
  const announcedNext = useRef(false);
  useEffect(() => {
    if (!state || !user) return;
    const readerId = state.reader?.id ?? null;
    if (previousReader.current !== undefined && readerId === user.id && previousReader.current !== user.id) {
      toast.show("It's your turn to read! Unmute on Discord and go ahead.", 'success');
      if (personal.sound) playChime();
      if (personal.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(`Your turn in ${state.name}`, { body: activeBook ? `Time to read “${activeBook.title}”.` : undefined });
      }
    }
    previousReader.current = readerId;
    const upNext = Boolean(state.reader && state.reader.id !== user.id && state.queue.find((m) => m.online)?.id === user.id);
    if (upNext && !announcedNext.current) toast.show("You're up next — get ready!", 'info');
    announcedNext.current = upNext;
  }, [state, user, toast, personal.sound, personal.notify, activeBook]);

  const roomPosition = state?.position ?? null;
  const targetPosition = controller || following ? roomPosition : (localPosition ?? roomPosition);
  const target = useMemo<ReaderTarget>(() => ({ position: targetPosition, version }), [targetPosition, version]);

  const onNavigate = useCallback(
    ({ position, scrollOnly }: NavigateEvent) => {
      if (!activeBook) return;
      if (controller) {
        room.setPosition(activeBook.id, position, true);
        return;
      }
      if (scrollOnly) {
        // Scrolling around the same page doesn't stop you from following the reader.
        if (!following) setLocalPosition(position);
        return;
      }
      setLocalPosition(position);
      setFollowing(false);
    },
    [activeBook, controller, following, room],
  );

  const backToGroup = () => {
    setFollowing(true);
    setLocalPosition(null);
    setVersion((v) => v + 1);
  };

  const bringEveryone = () => {
    if (!activeBook || !localPosition) return;
    room.setPosition(activeBook.id, localPosition, true);
    setFollowing(true);
    setLocalPosition(null);
    toast.show('Everyone is now on your page.', 'success');
  };

  const isMod = Boolean(view?.isMod);
  const viewerHighlights = useMemo<ViewerHighlights>(
    () => ({
      items: room.highlights,
      canEdit: isMod,
      add: (color, anchor, text, label) => {
        if (activeBook) void room.actions.addHighlight(activeBook.id, color, anchor, text, label);
      },
      remove: (id) => void room.actions.removeHighlight(id),
    }),
    [room.highlights, room.actions, isMod, activeBook],
  );

  const cues: CueProps = useMemo(
    () => ({
      canSend: controller,
      pointer: room.pointer,
      selection: room.selection,
      pointerName: state?.reader?.name ?? 'Moderator',
      sendPointer: (page, x, y) => activeBook && room.sendPointer(activeBook.id, page, x, y),
      sendSelection: (cfiRange) => activeBook && room.sendSelection(activeBook.id, cfiRange),
    }),
    [controller, room, state?.reader?.name, activeBook],
  );

  if (room.exit === 'deleted') return <ExitScreen title="Room closed" body="This reading room was deleted by its owner." />;
  if (room.exit === 'kicked') return <ExitScreen title="You were removed" body="A moderator removed you from this room. You can rejoin from the room list." />;
  if (room.exit === 'banned') return <ExitScreen title="You were banned" body="A moderator banned you from this room." />;
  if (room.error && !state) return <ExitScreen title="Can't open this room" body={room.error} />;
  if (!state || !view || !user) {
    return (
      <div className="center-screen">
        <Spinner label="Joining room…" />
      </div>
    );
  }

  let status;
  if (controller) {
    status = (
      <span className="status-pill live" title="Everyone following sees your page and your pointer">
        <Radio size={14} aria-hidden /> {view.isReader ? 'You turn the pages' : 'You guide the page'}
      </span>
    );
  } else if (following) {
    status = (
      <>
        <span className="status-pill">
          <Eye size={14} aria-hidden /> {state.reader ? `Following ${state.reader.name}` : 'On the group page'}
        </span>
      </>
    );
  } else {
    status = (
      <>
        <span className="status-pill warn">Browsing on your own</span>
        <button className="btn small primary" onClick={backToGroup}>
          <LocateFixed size={14} /> {state.reader ? `Back to ${state.reader.name}` : 'Back to group page'}
        </button>
        {view.isMod && (
          <button className="btn small" onClick={bringEveryone} title="Move everyone to the page you're on">
            Bring everyone here
          </button>
        )}
      </>
    );
  }

  return (
    <div className="room-page">
      <header className="room-header">
        <Link href="/" className="icon-btn ghost" aria-label="Back to rooms" title="All rooms">
          <ArrowLeft size={18} />
        </Link>
        <div className="room-title">
          <h1 className="clamp-1">{state.name}</h1>
          <span className="muted small clamp-1">
            {activeBook ? activeBook.title : 'No book open'} · <Users size={12} aria-hidden /> {state.members.length} here
          </span>
        </div>
        {!room.connected && (
          <span className="status-pill warn">
            <WifiOff size={14} aria-hidden /> Reconnecting…
          </span>
        )}
        <button
          className="icon-btn ghost sidebar-toggle"
          onClick={() => {
            setSidebarOpen((v) => !v);
            if (!sidebarOpen && tab === 'chat') setUnread(0);
          }}
          aria-label={sidebarOpen ? 'Hide side panel' : 'Show side panel'}
          title={sidebarOpen ? 'Hide side panel' : 'Show side panel'}
        >
          {sidebarOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          {!sidebarOpen && unread > 0 && <span className="badge">{unread}</span>}
        </button>
        <UserMenu />
      </header>

      <div className={cx('room-body', sidebarOpen && 'sidebar-open')}>
        <main className="room-main">
          {activeBook ? (
            <BookViewer
              key={activeBook.id}
              book={activeBook}
              target={target}
              onNavigate={onNavigate}
              cues={cues}
              status={status}
              highlights={viewerHighlights}
              dictionary={Boolean(config.dictionary) && personal.dictionary}
            />
          ) : (
            <div className="viewer-message">
              <LibraryBig size={40} aria-hidden />
              <h2>No book open yet</h2>
              <p className="muted">
                {view.isMod ? 'Upload a book in the Library tab to get started.' : 'A moderator will open a book soon.'}
              </p>
              {view.isMod && (
                <button
                  className="btn primary"
                  onClick={() => {
                    setTab('library');
                    setSidebarOpen(true);
                  }}
                >
                  Open the library
                </button>
              )}
            </div>
          )}
          <TurnBar state={state} view={view} room={room} />
        </main>

        <aside className="room-sidebar" aria-label="Room panel">
          <nav className="tabs" role="tablist">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={cx('tab', tab === id && 'active')}
                onClick={() => setTab(id)}
              >
                <Icon size={16} aria-hidden />
                <span>{label}</span>
                {id === 'chat' && unread > 0 && <span className="badge">{unread}</span>}
                {id === 'queue' && state.queue.length > 0 && <span className="badge subtle">{state.queue.length}</span>}
              </button>
            ))}
          </nav>
          <div className="tab-panel">
            {tab === 'queue' && <QueuePanel state={state} view={view} room={room} />}
            {tab === 'chat' && <ChatPanel state={state} view={view} room={room} active={tab === 'chat' && sidebarOpen} />}
            {tab === 'library' && <LibraryPanel state={state} view={view} room={room} />}
            {tab === 'settings' && (
              <SettingsPanel state={state} view={view} room={room} personal={personal} updatePersonal={updatePersonal} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
