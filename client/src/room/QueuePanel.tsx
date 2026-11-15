import { useState, type DragEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Crown,
  EllipsisVertical,
  GripVertical,
  ListPlus,
  ListX,
  Lock,
  LockOpen,
  Mic,
  Pause,
  Scale,
  Shield,
  ShieldOff,
  Shuffle,
  SkipForward,
  Trash2,
  UserMinus,
} from 'lucide-react';
import type { MemberInfo, RoomState } from '../../../shared/types';
import { Avatar, Menu, MenuItem, RoleBadge } from '../components/ui';
import { cx, formatDuration } from '../util';
import { RANK, useNow, type RoomPerspective } from './common';
import type { RoomApi } from './useRoom';
import { ReadingStats } from './ReadingStats';

function MemberActions({
  member,
  state,
  view,
  room,
}: {
  member: MemberInfo;
  state: RoomState;
  view: RoomPerspective;
  room: RoomApi;
}) {
  if (!view.isMod) return null;
  const { moderate } = room.actions;
  const queueIndex = state.queue.findIndex((m) => m.id === member.id);
  const isReader = state.reader?.id === member.id;
  const canTarget = member.id !== view.me.id && RANK[view.role] > RANK[member.role];
  const canManageMods = (view.role === 'owner' || view.role === 'admin') && member.role !== 'owner' && member.role !== 'admin';
  const isMod = state.moderators.includes(member.id);

  return (
    <Menu label={`Actions for ${member.name}`} trigger={<EllipsisVertical size={16} />}>
      {(close) => {
        const act = (fn: () => void) => () => {
          close();
          fn();
        };
        return (
          <>
            {!isReader && (member.online || queueIndex >= 0) && (
              <MenuItem icon={<Mic size={16} />} onClick={act(() => moderate({ type: 'reader.set', userId: member.id }))}>
                Make reader now
              </MenuItem>
            )}
            {queueIndex < 0 && !isReader && member.online && (
              <MenuItem icon={<ListPlus size={16} />} onClick={act(() => moderate({ type: 'queue.add', userId: member.id }))}>
                Add to queue
              </MenuItem>
            )}
            {queueIndex > 0 && (
              <MenuItem
                icon={<ArrowUp size={16} />}
                onClick={act(() => moderate({ type: 'queue.move', userId: member.id, index: 0 }))}
              >
                Move to front
              </MenuItem>
            )}
            {queueIndex >= 0 && queueIndex < state.queue.length - 1 && (
              <MenuItem
                icon={<ArrowDown size={16} />}
                onClick={act(() => moderate({ type: 'queue.move', userId: member.id, index: state.queue.length - 1 }))}
              >
                Move to back
              </MenuItem>
            )}
            {queueIndex >= 0 && (
              <MenuItem icon={<ListX size={16} />} onClick={act(() => moderate({ type: 'queue.remove', userId: member.id }))}>
                Remove from queue
              </MenuItem>
            )}
            {canManageMods &&
              (isMod ? (
                <MenuItem icon={<ShieldOff size={16} />} onClick={act(() => moderate({ type: 'mod.revoke', userId: member.id }))}>
                  Remove moderator
                </MenuItem>
              ) : (
                <MenuItem icon={<Shield size={16} />} onClick={act(() => moderate({ type: 'mod.grant', userId: member.id }))}>
                  Make moderator
                </MenuItem>
              ))}
            {canTarget && member.online && (
              <MenuItem
                icon={<UserMinus size={16} />}
                danger
                onClick={act(() => moderate({ type: 'member.kick', userId: member.id }))}
              >
                Remove from room
              </MenuItem>
            )}
            {canTarget && (
              <MenuItem
                icon={<Ban size={16} />}
                danger
                onClick={act(() => {
                  if (window.confirm(`Ban ${member.name} from this room?`)) moderate({ type: 'member.ban', userId: member.id });
                })}
              >
                Ban from room
              </MenuItem>
            )}
          </>
        );
      }}
    </Menu>
  );
}

function MemberRow({
  member,
  state,
  view,
  room,
  index,
  dragging,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  member: MemberInfo;
  state: RoomState;
  view: RoomPerspective;
  room: RoomApi;
  index?: number;
  dragging?: boolean;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
}) {
  const isMe = member.id === view.me.id;
  return (
    <li
      className={cx('member-row', isMe && 'is-me', !member.online && 'offline', dragging && 'dragging')}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {draggable && <GripVertical size={14} className="drag-handle" aria-hidden />}
      {index !== undefined && <span className="queue-number">{index + 1}</span>}
      <Avatar id={member.id} name={member.name} url={member.avatarUrl} size={28} online={member.online} />
      <span className="member-name">
        <span className="clamp-1">{member.name}</span>
        {isMe && <span className="muted small"> (you)</span>}
      </span>
      <RoleBadge role={member.role} />
      <MemberActions member={member} state={state} view={view} room={room} />
    </li>
  );
}

export function QueuePanel({ state, view, room }: { state: RoomState; view: RoomPerspective; room: RoomApi }) {
  const now = useNow(1000);
  const { moderate } = room.actions;
  const [dragId, setDragId] = useState<string | null>(null);
  const reader = state.reader;
  const inLine = new Set(state.queue.map((m) => m.id));
  const others = state.members
    .filter((m) => !inLine.has(m.id) && m.id !== reader?.id)
    .sort((a, b) => RANK[b.role] - RANK[a.role] || a.name.localeCompare(b.name));

  const drop = (index: number) => (e: DragEvent) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData('text/plain');
    setDragId(null);
    if (id) moderate({ type: 'queue.move', userId: id, index });
  };

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h3 className="section-title">Now reading</h3>
        {reader ? (
          <div className={cx('reader-card', reader.id === view.me.id && 'is-me')}>
            <Avatar id={reader.id} name={reader.name} url={reader.avatarUrl} size={44} online={reader.online} />
            <div className="reader-card-text">
              <strong className="clamp-1">
                {reader.name} <RoleBadge role={reader.role} />
              </strong>
              <span className="muted small">
                {reader.online ? 'reading for' : 'disconnected ·'} {formatDuration(now + room.clockOffset.current - reader.since)}
              </span>
              {!reader.online && state.settings.autoSkipOffline && (
                <span className="muted small">Skipped automatically if not back soon</span>
              )}
            </div>
            {view.isMod && (
              <div className="reader-card-actions">
                <button className="icon-btn" title="Skip to next reader" aria-label="Skip reader" onClick={() => moderate({ type: 'reader.skip' })}>
                  <SkipForward size={16} />
                </button>
                <button
                  className="icon-btn"
                  title="Pause: end this turn and put them first in line"
                  aria-label="Pause turn"
                  onClick={() => moderate({ type: 'reader.stop' })}
                >
                  <Pause size={16} />
                </button>
                <MemberActions member={reader} state={state} view={view} room={room} />
              </div>
            )}
          </div>
        ) : (
          <p className="muted small">Nobody yet. The first person in line starts the next turn.</p>
        )}
      </section>

      <section className="panel-section">
        <div className="section-head">
          <h3 className="section-title">
            Up next <span className="count">{state.queue.length}</span>
          </h3>
          {view.isMod && (
            <div className="section-tools">
              <button
                className="icon-btn ghost"
                title={state.settings.queueLocked ? 'Unlock queue' : 'Lock queue (only mods can add people)'}
                aria-label={state.settings.queueLocked ? 'Unlock queue' : 'Lock queue'}
                onClick={() => moderate({ type: 'settings', settings: { queueLocked: !state.settings.queueLocked } })}
              >
                {state.settings.queueLocked ? <Lock size={15} /> : <LockOpen size={15} />}
              </button>
              <button
                className="icon-btn ghost"
                title="Least-read first: order the queue by reading time on this book"
                aria-label="Order queue by least reading time"
                disabled={state.queue.length < 2}
                onClick={() => moderate({ type: 'queue.fair' })}
              >
                <Scale size={15} />
              </button>
              <button
                className="icon-btn ghost"
                title="Shuffle queue"
                aria-label="Shuffle queue"
                disabled={state.queue.length < 2}
                onClick={() => moderate({ type: 'queue.shuffle' })}
              >
                <Shuffle size={15} />
              </button>
              <button
                className="icon-btn ghost"
                title="Clear queue"
                aria-label="Clear queue"
                disabled={state.queue.length === 0}
                onClick={() => window.confirm('Remove everyone from the queue?') && moderate({ type: 'queue.clear' })}
              >
                <Trash2 size={15} />
              </button>
            </div>
          )}
        </div>
        {state.settings.queueLocked && (
          <p className="notice small">
            <Lock size={12} aria-hidden /> Queue locked — moderators add readers.
          </p>
        )}
        {state.queue.length === 0 ? (
          <p className="muted small">The queue is empty.</p>
        ) : (
          <ol className="member-list" onDragEnd={() => setDragId(null)}>
            {state.queue.map((member, index) => (
              <MemberRow
                key={member.id}
                member={member}
                state={state}
                view={view}
                room={room}
                index={index}
                draggable={view.isMod}
                dragging={dragId === member.id}
                onDragStart={(e) => {
                  setDragId(member.id);
                  e.dataTransfer.setData('text/plain', member.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => view.isMod && e.preventDefault()}
                onDrop={drop(index)}
              />
            ))}
          </ol>
        )}
        {state.settings.rotate && state.queue.length > 0 && (
          <p className="muted small">Readers rejoin the end of the line after their turn.</p>
        )}
      </section>

      <section className="panel-section">
        <h3 className="section-title">
          Listening <span className="count">{others.length}</span>
        </h3>
        {others.length === 0 ? (
          <p className="muted small">Everyone here is in the reading order.</p>
        ) : (
          <ul className="member-list">
            {others.map((member) => (
              <MemberRow key={member.id} member={member} state={state} view={view} room={room} />
            ))}
          </ul>
        )}
      </section>

      <ReadingStats state={state} room={room} />

      {view.isMod && state.banned.length > 0 && (
        <section className="panel-section">
          <h3 className="section-title">Banned</h3>
          <ul className="member-list">
            {state.banned.map((b) => (
              <li key={b.id} className="member-row offline">
                <Ban size={14} aria-hidden />
                <span className="member-name clamp-1">{b.name}</span>
                <button className="btn small ghost" onClick={() => moderate({ type: 'member.unban', userId: b.id })}>
                  Unban
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="muted small legend">
        <Crown size={12} aria-hidden /> owner · <Shield size={12} aria-hidden /> moderator
      </p>
    </div>
  );
}
