import { Check, Hand, LogOut, Mic, Play, SkipForward, UserPlus } from 'lucide-react';
import type { RoomState } from '../../../shared/types';
import { Avatar } from '../components/ui';
import { formatDuration } from '../util';
import { useNow, type RoomPerspective } from './common';
import type { RoomApi } from './useRoom';

export function TurnBar({ state, view, room }: { state: RoomState; view: RoomPerspective; room: RoomApi }) {
  const now = useNow(1000);
  const { reader } = state;
  const { actions } = room;
  const elapsed = reader ? now + room.clockOffset.current - reader.since : 0;
  const canStart = !reader && state.queue.length > 0 && (view.isMod || view.nextUp?.id === view.me.id);
  const queueLocked = state.settings.queueLocked && !view.isMod;

  return (
    <div className={`turn-bar ${view.isReader ? 'my-turn' : ''}`}>
      <div className="turn-current">
        {reader ? (
          <>
            <Avatar id={reader.id} name={reader.name} url={reader.avatarUrl} size={34} online={reader.online} />
            <div className="turn-text">
              <strong>{view.isReader ? 'Your turn to read' : `${reader.name} is reading`}</strong>
              <span className="muted small">
                <Mic size={12} aria-hidden /> {formatDuration(elapsed)}
                {!reader.online && ' · disconnected'}
                {state.queue.length > 0 && view.nextUp && ` · next: ${view.nextUp.id === view.me.id ? 'you' : view.nextUp.name}`}
              </span>
            </div>
          </>
        ) : (
          <div className="turn-text">
            <strong>Nobody is reading</strong>
            <span className="muted small">
              {state.queue.length ? `${state.queue.length} waiting in line` : 'Join the queue to take a turn'}
            </span>
          </div>
        )}
      </div>

      <div className="turn-actions">
        {view.isReader ? (
          <>
            <button className="btn ghost" onClick={actions.passTurn} title="Hand the turn to the next person without reading">
              <SkipForward size={16} /> Pass
            </button>
            <button className="btn success" onClick={actions.finishTurn}>
              <Check size={16} /> Finish turn
            </button>
          </>
        ) : (
          <>
            {canStart && (
              <button className="btn success" onClick={actions.startTurn}>
                <Play size={16} /> {view.nextUp?.id === view.me.id ? 'Start reading' : 'Start next turn'}
              </button>
            )}
            {view.queueIndex >= 0 ? (
              <>
                <span className="queue-position">
                  <Hand size={14} aria-hidden /> #{view.queueIndex + 1} in line
                </span>
                <button className="btn ghost" onClick={actions.leaveQueue}>
                  <LogOut size={16} /> Leave queue
                </button>
              </>
            ) : (
              <button
                className="btn primary"
                onClick={actions.joinQueue}
                disabled={queueLocked}
                title={queueLocked ? 'The queue is locked by a moderator' : 'Get in line to read'}
              >
                <UserPlus size={16} /> {queueLocked ? 'Queue locked' : 'Join queue'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
