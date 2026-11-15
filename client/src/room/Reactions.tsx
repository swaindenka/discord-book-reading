import { useState } from 'react';
import { SmilePlus, X } from 'lucide-react';
import { REACTIONS, type ReactionEvent } from '../../../shared/types';
import { cx } from '../util';

/** Emoji that float up over the book for everyone, like reactions on a stream. */
export function ReactionLayer({ reactions }: { reactions: (ReactionEvent & { key: number })[] }) {
  return (
    <div className="reaction-layer" aria-live="polite">
      {reactions.map((r) => (
        <span key={r.key} className="floating-reaction" style={{ right: `${24 + ((r.key * 37) % 120)}px` }}>
          <span className="floating-emoji" aria-hidden>
            {r.emoji}
          </span>
          <span className="floating-name">{r.name}</span>
          <span className="sr-only">
            {r.name} reacted {r.emoji}
          </span>
        </span>
      ))}
    </div>
  );
}

export function ReactionBar({ onReact }: { onReact: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('reaction-bar', open && 'open')}>
      {open &&
        REACTIONS.map((emoji) => (
          <button key={emoji} className="reaction-btn" onClick={() => onReact(emoji)} aria-label={`React ${emoji}`}>
            {emoji}
          </button>
        ))}
      <button
        className="reaction-btn toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Close reactions' : 'React'}
        title={open ? 'Close reactions' : 'React to what is being read'}
      >
        {open ? <X size={16} /> : <SmilePlus size={18} />}
      </button>
    </div>
  );
}
