import { Eye, EyeOff, Highlighter, Trash2 } from 'lucide-react';
import { HIGHLIGHT_COLORS, type BookHighlight, type HighlightColor } from '../../../shared/types';
import { Menu } from '../components/ui';
import { cx } from '../util';

/** Moderator tool: turn the highlighter on and pick its colour. */
export function HighlighterToggle({
  active,
  color,
  onToggle,
  onColor,
  areaOnly,
}: {
  active: boolean;
  color: HighlightColor;
  onToggle: () => void;
  onColor: (color: HighlightColor) => void;
  areaOnly: boolean;
}) {
  const hint = areaOnly ? 'Drag over the page to highlight an area' : 'Select text to highlight it';
  return (
    <div className={cx('highlighter', active && 'active')}>
      <button
        className={cx('icon-btn', active && 'on')}
        aria-pressed={active}
        aria-label={active ? 'Turn the highlighter off' : 'Turn the highlighter on'}
        title={active ? 'Highlighter on (Esc to turn off)' : `Highlighter: ${hint.toLowerCase()}`}
        onClick={onToggle}
        style={active ? { ['--hl-color' as string]: HIGHLIGHT_COLORS[color].css } : undefined}
      >
        <Highlighter size={16} />
      </button>
      {active && (
        <>
          <div className="swatches" role="radiogroup" aria-label="Highlight colour">
            {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={c === color}
                className={cx('swatch', c === color && 'selected')}
                style={{ background: HIGHLIGHT_COLORS[c].css }}
                aria-label={HIGHLIGHT_COLORS[c].label}
                title={HIGHLIGHT_COLORS[c].label}
                onClick={() => onColor(c)}
              />
            ))}
          </div>
          <span className="highlighter-hint">{hint}</span>
        </>
      )}
    </div>
  );
}

/** Everyone: the list of saved highlights, to jump to them (and remove them, for moderators). */
export function HighlightsMenu({
  highlights,
  visible,
  onToggleVisible,
  onGo,
  onRemove,
}: {
  highlights: BookHighlight[];
  visible: boolean;
  onToggleVisible: () => void;
  onGo: (highlight: BookHighlight) => void;
  onRemove?: (highlight: BookHighlight) => void;
}) {
  return (
    <Menu
      label={`Highlights (${highlights.length})`}
      align="start"
      trigger={
        <span className="hl-trigger">
          <Highlighter size={16} aria-hidden />
          <span className="hl-count">{highlights.length}</span>
        </span>
      }
    >
      {(close) => (
        <div className="hl-menu">
          <div className="hl-menu-head">
            <strong>Highlights</strong>
            <button className="btn small ghost" onClick={onToggleVisible}>
              {visible ? <EyeOff size={14} /> : <Eye size={14} />} {visible ? 'Hide' : 'Show'}
            </button>
          </div>
          {highlights.length === 0 && <p className="muted small hl-empty">Nothing highlighted in this book yet.</p>}
          <div className="hl-list">
            {highlights.map((h) => (
              <div key={h.id} className="hl-item">
                <button
                  className="hl-item-main"
                  onClick={() => {
                    close();
                    onGo(h);
                  }}
                >
                  <span className="hl-dot" style={{ background: HIGHLIGHT_COLORS[h.color].css }} aria-hidden />
                  <span className="hl-item-text">
                    <span className="clamp-2">{h.text || 'Marked area'}</span>
                    <span className="muted small">
                      {[h.label, h.createdByName].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
                {onRemove && (
                  <button className="icon-btn ghost" aria-label="Remove highlight" title="Remove highlight" onClick={() => onRemove(h)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Menu>
  );
}
