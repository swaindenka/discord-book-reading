import { useEffect, useState } from 'react';
import type { ReaderStat, RoomState } from '../../../shared/types';
import { Avatar } from '../components/ui';
import { cx } from '../util';
import type { RoomApi } from './useRoom';

export function formatReadingTime(seconds: number) {
  if (seconds < 60) return seconds > 0 ? '<1 min' : '0 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Who has read how much, so turns can be shared fairly. */
export function ReadingStats({ state, room }: { state: RoomState; room: RoomApi }) {
  const [scope, setScope] = useState<'book' | 'room'>('book');
  const [stats, setStats] = useState<ReaderStat[] | null>(null);
  const turnKey = `${state.reader?.id ?? ''}:${state.reader?.since ?? ''}:${state.activeBookId}`;
  const { loadStats } = room;

  useEffect(() => {
    let alive = true;
    const load = () =>
      loadStats(scope)
        .then((s) => alive && setStats(s))
        .catch(() => alive && setStats((prev) => prev ?? []));
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [scope, turnKey, loadStats]);

  const max = Math.max(60, ...(stats ?? []).map((s) => s.seconds));
  const readIds = new Set((stats ?? []).filter((s) => s.turns > 0).map((s) => s.userId));
  const notYet = state.members.filter((m) => !readIds.has(m.id));

  return (
    <section className="panel-section">
      <div className="section-head">
        <h3 className="section-title">Reading time</h3>
        <div className="segmented small" role="radiogroup" aria-label="Reading time for">
          {(['book', 'room'] as const).map((s) => (
            <button key={s} role="radio" aria-checked={scope === s} className={cx(scope === s && 'active')} onClick={() => setScope(s)}>
              {s === 'book' ? 'This book' : 'All books'}
            </button>
          ))}
        </div>
      </div>
      {stats === null ? (
        <p className="muted small">Loading…</p>
      ) : stats.length === 0 ? (
        <p className="muted small">Nobody has read {scope === 'book' ? 'this book' : 'here'} yet.</p>
      ) : (
        <ul className="stat-list">
          {stats.map((s) => (
            <li key={s.userId} className="stat-row">
              <Avatar id={s.userId} name={s.name} url={s.avatarUrl} size={24} />
              <div className="stat-main">
                <div className="stat-line">
                  <span className="clamp-1">{s.name}</span>
                  <span className="muted small tabular">
                    {formatReadingTime(s.seconds)} · {s.turns} turn{s.turns === 1 ? '' : 's'}
                    {s.passes > 0 && ` · passed ${s.passes}×`}
                  </span>
                </div>
                <div className="stat-bar" aria-hidden>
                  <div style={{ width: `${Math.max(2, (s.seconds / max) * 100)}%` }} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {stats !== null && notYet.length > 0 && (
        <p className="muted small not-yet">
          Hasn't read {scope === 'book' ? 'this book' : 'here'} yet: {notYet.map((m) => m.name).join(', ')}
        </p>
      )}
    </section>
  );
}
