import { useEffect, useState } from 'react';
import { BellRing, CalendarClock, Send, Unlink } from 'lucide-react';
import type { RoomState } from '../../../shared/types';
import { Toggle } from '../components/ui';
import { useToast } from '../components/Toasts';
import { formatSession, fromLocalInput, isUpcoming, toLocalInput } from '../schedule';
import type { RoomApi } from './useRoom';

/** Moderators: when the next session is. Shown to everyone in their own time zone. */
export function ScheduleSettings({ state, room }: { state: RoomState; room: RoomApi }) {
  const toast = useToast();
  const at = state.settings.nextSessionAt;
  const [value, setValue] = useState(isUpcoming(at) ? toLocalInput(at) : '');

  useEffect(() => {
    setValue(isUpcoming(at) ? toLocalInput(at) : '');
  }, [at]);

  const save = async (next: number | null) => {
    if (await room.actions.moderate({ type: 'settings', settings: { nextSessionAt: next } })) {
      toast.show(next ? 'Next session saved.' : 'Next session cleared.', 'success');
    }
  };

  return (
    <section className="panel-section">
      <h3 className="section-title">
        <CalendarClock size={14} aria-hidden /> Next session
      </h3>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const ms = fromLocalInput(value);
          if (ms) void save(ms);
        }}
      >
        <label className="field">
          <span>Date and time (your time zone)</span>
          <input id="next-session" className="input" type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {isUpcoming(at) && <p className="muted small">Everyone sees: {formatSession(at)} in their own time.</p>}
        <div className="form-actions">
          {isUpcoming(at) && (
            <button type="button" className="btn small ghost" onClick={() => void save(null)}>
              Clear
            </button>
          )}
          <button className="btn small primary" disabled={!value}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}

/** Moderators: post turn changes to a Discord channel through a webhook. */
export function DiscordSettings({ state, room }: { state: RoomState; room: RoomApi }) {
  const toast = useToast();
  const { moderate } = room.actions;
  const [url, setUrl] = useState('');
  const settings = state.settings;

  const connect = async () => {
    if (await moderate({ type: 'webhook.set', url })) {
      setUrl('');
      toast.show('Discord notifications connected.', 'success');
    }
  };

  return (
    <section className="panel-section">
      <h3 className="section-title">
        <BellRing size={14} aria-hidden /> Discord notifications
      </h3>
      {state.webhookConnected ? (
        <>
          <p className="notice small ok">Connected to a Discord channel.</p>
          <Toggle
            checked={settings.notifyStart}
            onChange={(v) => moderate({ type: 'settings', settings: { notifyStart: v } })}
            label="Session started, book changes and schedule"
          />
          <Toggle
            checked={settings.notifyTurns}
            onChange={(v) => moderate({ type: 'settings', settings: { notifyTurns: v } })}
            label="Every turn change"
          />
          <Toggle
            checked={settings.pingReaders}
            onChange={(v) => moderate({ type: 'settings', settings: { pingReaders: v } })}
            label="@mention the next reader"
            hint="They get a Discord ping when it's their turn."
          />
          <div className="row wrap">
            <button
              className="btn small"
              onClick={async () => {
                if (await moderate({ type: 'webhook.test' })) toast.show('Test message sent to Discord.', 'success');
              }}
            >
              <Send size={14} /> Send test message
            </button>
            <button className="btn small ghost" onClick={() => moderate({ type: 'webhook.set', url: '' })}>
              <Unlink size={14} /> Disconnect
            </button>
          </div>
        </>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <p className="muted small">
            Post "reading has started" and "it's your turn" messages to a channel, with a ping for the next reader. In Discord:
            Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
          </p>
          <label className="field">
            <span>Webhook URL</span>
            <input
              id="webhook-url"
              className="input"
              type="password"
              autoComplete="off"
              placeholder="https://discord.com/api/webhooks/…"
              value={url}
              onChange={(e) => setUrl(e.target.value.trim())}
            />
          </label>
          <button className="btn small primary" disabled={!url}>
            Connect
          </button>
        </form>
      )}
    </section>
  );
}
