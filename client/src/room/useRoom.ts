import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BookHighlight,
  ChatMessage,
  HighlightAnchor,
  HighlightColor,
  ModAction,
  PointerEvent,
  Position,
  ReactionEvent,
  ReaderStat,
  RoomState,
  SelectionCue,
} from '../../../shared/types';
import { getSocket, request } from '../socket';
import { useToast } from '../components/Toasts';

export type RoomExit = 'kicked' | 'banned' | 'deleted' | null;

/** Live room state over Socket.IO, plus actions that report errors as toasts. */
export function useRoom(roomId: string) {
  const toast = useToast();
  const [state, setState] = useState<RoomState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [exit, setExit] = useState<RoomExit>(null);
  const [pointer, setPointer] = useState<PointerEvent | null>(null);
  const [selection, setSelection] = useState<SelectionCue | null>(null);
  /** Recent reactions, newest last; each fades out on its own. */
  const [reactions, setReactions] = useState<(ReactionEvent & { key: number })[]>([]);
  const reactionKey = useRef(0);
  const [highlightSet, setHighlightSet] = useState<{ bookId: string | null; items: BookHighlight[] }>({
    bookId: null,
    items: [],
  });
  /** server clock − local clock, for turn timers. */
  const clockOffset = useRef(0);

  useEffect(() => {
    const socket = getSocket();
    let alive = true;

    const join = () => {
      request<{ state: RoomState; messages: ChatMessage[]; highlights: BookHighlight[] }>('room:join', { roomId })
        .then((res) => {
          if (!alive) return;
          clockOffset.current = res.state.serverTime - Date.now();
          setState(res.state);
          setMessages(res.messages);
          setHighlightSet({ bookId: res.state.activeBookId, items: res.highlights });
          setError(null);
        })
        .catch((err: Error) => alive && setError(err.message));
    };

    const onConnect = () => {
      setConnected(true);
      join();
    };
    const onDisconnect = () => setConnected(false);
    const onState = (next: RoomState) => {
      if (next.id !== roomId) return;
      clockOffset.current = next.serverTime - Date.now();
      setState(next);
    };
    const onPosition = ({ bookId, position }: { bookId: string; position: Position }) =>
      setState((s) =>
        s && s.activeBookId === bookId
          ? { ...s, position, books: s.books.map((b) => (b.id === bookId ? { ...b, position } : b)) }
          : s,
      );
    const onMessage = (message: ChatMessage) => setMessages((list) => [...list, message].slice(-400));
    const onDeleted = ({ id }: { id: string }) => setMessages((list) => list.filter((m) => m.id !== id));
    const onKicked = ({ banned }: { banned: boolean }) => setExit(banned ? 'banned' : 'kicked');
    const onRoomDeleted = () => setExit('deleted');
    const onReaction = (r: ReactionEvent) => {
      const key = ++reactionKey.current;
      setReactions((list) => [...list.slice(-24), { ...r, key }]);
      setTimeout(() => setReactions((list) => list.filter((x) => x.key !== key)), 3200);
    };
    const onHighlightsSet = ({ bookId, highlights }: { bookId: string; highlights: BookHighlight[] }) =>
      setHighlightSet({ bookId, items: highlights });
    const onHighlightAdded = (h: BookHighlight) =>
      setHighlightSet((set) =>
        set.bookId === h.bookId && !set.items.some((x) => x.id === h.id) ? { ...set, items: [...set.items, h] } : set,
      );
    const onHighlightRemoved = ({ id }: { id: string }) =>
      setHighlightSet((set) => ({ ...set, items: set.items.filter((h) => h.id !== id) }));
    const onConnectError = (err: Error) => {
      if (err.message === 'unauthorized') window.location.assign(`/login?returnTo=${encodeURIComponent(`/room/${roomId}`)}`);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('room:state', onState);
    socket.on('nav:position', onPosition);
    socket.on('chat:message', onMessage);
    socket.on('chat:deleted', onDeleted);
    socket.on('room:kicked', onKicked);
    socket.on('room:deleted', onRoomDeleted);
    socket.on('pointer', setPointer);
    socket.on('selection', setSelection);
    socket.on('reaction', onReaction);
    socket.on('highlights:set', onHighlightsSet);
    socket.on('highlight:added', onHighlightAdded);
    socket.on('highlight:removed', onHighlightRemoved);
    if (socket.connected) join();

    return () => {
      alive = false;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('room:state', onState);
      socket.off('nav:position', onPosition);
      socket.off('chat:message', onMessage);
      socket.off('chat:deleted', onDeleted);
      socket.off('room:kicked', onKicked);
      socket.off('room:deleted', onRoomDeleted);
      socket.off('pointer', setPointer);
      socket.off('selection', setSelection);
      socket.off('reaction', onReaction);
      socket.off('highlights:set', onHighlightsSet);
      socket.off('highlight:added', onHighlightAdded);
      socket.off('highlight:removed', onHighlightRemoved);
      socket.emit('room:leave');
    };
  }, [roomId]);

  const run = useCallback(
    async (event: Parameters<typeof request>[0], payload?: unknown) => {
      try {
        await request(event, payload);
        return true;
      } catch (err) {
        toast.error(err);
        return false;
      }
    },
    [toast],
  );

  const actions = useMemo(
    () => ({
      joinQueue: () => run('queue:join'),
      leaveQueue: () => run('queue:leave'),
      startTurn: () => run('turn:start'),
      finishTurn: () => run('turn:finish'),
      passTurn: () => run('turn:pass'),
      sendChat: (body: string) => run('chat:send', { body }),
      deleteMessage: (messageId: string) => run('chat:delete', { messageId }),
      moderate: (action: ModAction) => run('mod:action', action),
      addHighlight: (bookId: string, color: HighlightColor, anchor: HighlightAnchor, text: string, label: string) =>
        run('highlight:add', { bookId, color, anchor, text, label }),
      removeHighlight: (id: string) => run('highlight:remove', { id }),
    }),
    [run],
  );

  /** Moves everyone (when allowed) and updates our copy right away. */
  const setPosition = useCallback((bookId: string, position: Position, broadcast: boolean) => {
    setState((s) =>
      s && s.activeBookId === bookId
        ? { ...s, position, books: s.books.map((b) => (b.id === bookId ? { ...b, position } : b)) }
        : s,
    );
    if (broadcast) getSocket().emit('nav:set', { bookId, position });
  }, []);

  const sendPointer = useCallback((bookId: string, page: number, x: number | null, y: number | null) => {
    getSocket().volatile.emit('pointer', { bookId, page, x, y });
  }, []);

  const sendReaction = useCallback((emoji: string) => {
    getSocket().emit('reaction', { emoji });
  }, []);

  const reportPages = useCallback((bookId: string, pageCount: number) => {
    getSocket().emit('book:pages', { bookId, pageCount });
  }, []);

  const loadStats = useCallback(
    async (scope: 'book' | 'room') => (await request<{ stats: ReaderStat[] }>('stats:get', { scope })).stats,
    [],
  );

  const sendSelection = useCallback((bookId: string, cfiRange: string | null) => {
    getSocket().emit('selection', { bookId, cfiRange });
  }, []);

  const highlights = state && highlightSet.bookId === state.activeBookId ? highlightSet.items : [];

  return {
    state,
    messages,
    error,
    connected,
    exit,
    pointer,
    selection,
    highlights,
    reactions,
    clockOffset,
    actions,
    setPosition,
    sendPointer,
    sendSelection,
    sendReaction,
    reportPages,
    loadStats,
  };
}

export type RoomApi = ReturnType<typeof useRoom>;
