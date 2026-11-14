import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BookOpen, Send, Trash2 } from 'lucide-react';
import type { ChatMessage, RoomState } from '../../../shared/types';
import { LIMITS } from '../../../shared/types';
import { Avatar } from '../components/ui';
import { cx, formatDay, formatTime } from '../util';
import type { RoomPerspective } from './common';
import type { RoomApi } from './useRoom';

const URL_PATTERN = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

function linkify(text: string): ReactNode[] {
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

const GROUP_MS = 5 * 60_000;

export function ChatPanel({
  state,
  view,
  room,
  active,
}: {
  state: RoomState;
  view: RoomPerspective;
  room: RoomApi;
  active: boolean;
}) {
  const { messages, actions } = room;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, active]);

  useEffect(() => {
    if (active) inputRef.current?.focus({ preventScroll: true });
  }, [active]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    stickToBottom.current = true;
    if (await actions.sendChat(body)) setDraft('');
    setSending(false);
    inputRef.current?.focus();
  };

  const canDelete = (m: ChatMessage) => view.isMod || (m.userId !== null && m.userId === view.me.id);
  const mention = `@${view.me.name.toLowerCase()}`;

  return (
    <div className="chat">
      <div
        className="chat-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.length === 0 && (
          <p className="muted small center chat-empty">No messages yet. Say hi to {state.name}!</p>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || formatDay(prev.createdAt) !== formatDay(m.createdAt);
          const grouped =
            !newDay && prev && prev.kind === 'user' && m.kind === 'user' && prev.userId === m.userId && m.createdAt - prev.createdAt < GROUP_MS;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="chat-day">{formatDay(m.createdAt)}</div>}
              {m.kind === 'system' ? (
                <div className="chat-system">
                  <BookOpen size={12} aria-hidden />
                  <span>{m.body}</span>
                  <time className="muted">{formatTime(m.createdAt)}</time>
                </div>
              ) : (
                <div
                  className={cx(
                    'chat-message',
                    grouped && 'grouped',
                    m.userId === view.me.id && 'mine',
                    m.body.toLowerCase().includes(mention) && 'mentioned',
                  )}
                >
                  {!grouped ? (
                    <Avatar id={m.userId ?? m.authorName} name={m.authorName} url={m.authorAvatar} size={32} />
                  ) : (
                    <time className="chat-gutter-time muted">{formatTime(m.createdAt)}</time>
                  )}
                  <div className="chat-content">
                    {!grouped && (
                      <div className="chat-meta">
                        <strong>{m.authorName}</strong>
                        <time className="muted small">{formatTime(m.createdAt)}</time>
                      </div>
                    )}
                    <div className="chat-body">{linkify(m.body)}</div>
                  </div>
                  {canDelete(m) && (
                    <button
                      className="icon-btn ghost chat-delete"
                      aria-label="Delete message"
                      title="Delete message"
                      onClick={() => actions.deleteMessage(m.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <textarea
          ref={inputRef}
          className="input chat-input"
          rows={1}
          value={draft}
          maxLength={LIMITS.chatMessage}
          placeholder={`Message ${state.name}`}
          aria-label="Chat message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="icon-btn primary" aria-label="Send" disabled={!draft.trim() || sending}>
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
