import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage,
  HighlightEvent,
  ModAction,
  PointerEvent,
  Position,
  RoomState,
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
  const [highlight, setHighlight] = useState<HighlightEvent | null>(null);
  /** server clock − local clock, for turn timers. */
  const clockOffset = useRef(0);

  useEffect(() => {
    const socket = getSocket();
    let alive = true;

    const join = () => {
      request<{ state: RoomState; messages: ChatMessage[] }>('room:join', { roomId })
        .then((res) => {
          if (!alive) return;
          clockOffset.current = res.state.serverTime - Date.now();
          setState(res.state);
          setMessages(res.messages);
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
    socket.on('highlight', setHighlight);
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
      socket.off('highlight', setHighlight);
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

  const sendHighlight = useCallback((bookId: string, cfiRange: string | null) => {
    getSocket().emit('highlight', { bookId, cfiRange });
  }, []);

  return {
    state,
    messages,
    error,
    connected,
    exit,
    pointer,
    highlight,
    clockOffset,
    actions,
    setPosition,
    sendPointer,
    sendHighlight,
  };
}

export type RoomApi = ReturnType<typeof useRoom>;
