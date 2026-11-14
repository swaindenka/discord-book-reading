import { useEffect, useState, type FormEvent } from 'react';
import { Bell, Copy, Trash2 } from 'lucide-react';
import type { RoomState } from '../../../shared/types';
import { LIMITS } from '../../../shared/types';
import { api } from '../api';
import { Toggle } from '../components/ui';
import { useToast } from '../components/Toasts';
import { navigate } from '../router';
import { useSession } from '../session';
import { loadPref, savePref } from '../util';
import type { RoomPerspective } from './common';
import type { RoomApi } from './useRoom';

export interface PersonalPrefs {
  sound: boolean;
  notify: boolean;
  dictionary: boolean;
}

export const DEFAULT_PERSONAL: PersonalPrefs = { sound: true, notify: false, dictionary: true };

export function usePersonalPrefs() {
  const [prefs, setPrefs] = useState<PersonalPrefs>(() => loadPref('personal', DEFAULT_PERSONAL));
  const update = (patch: Partial<PersonalPrefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePref('personal', next);
      return next;
    });
  return [prefs, update] as const;
}

export function SettingsPanel({
  state,
  view,
  room,
  personal,
  updatePersonal,
}: {
  state: RoomState;
  view: RoomPerspective;
  room: RoomApi;
  personal: PersonalPrefs;
  updatePersonal: (patch: Partial<PersonalPrefs>) => void;
}) {
  const toast = useToast();
  const { config } = useSession();
  const { moderate } = room.actions;
  const [name, setName] = useState(state.name);
  const [description, setDescription] = useState(state.description);
  const settings = state.settings;

  useEffect(() => {
    setName(state.name);
    setDescription(state.description);
  }, [state.name, state.description]);

  const saveDetails = async (e: FormEvent) => {
    e.preventDefault();
    if (await moderate({ type: 'room.update', name, description })) toast.show('Room updated.', 'success');
  };

  const copyLink = async () => {
    const url = `${window.location.origin}/room/${state.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.show('Invite link copied — paste it in Discord.', 'success');
    } catch {
      window.prompt('Copy this link:', url);
    }
  };

  const enableNotifications = async (on: boolean) => {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') {
        toast.show('Notifications are blocked in your browser settings.', 'error');
        return;
      }
    }
    updatePersonal({ notify: on });
  };

  const deleteRoom = async () => {
    if (!window.confirm(`Delete “${state.name}” with all its books and chat? This cannot be undone.`)) return;
    try {
      await api.deleteRoom(state.id);
      navigate('/');
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="panel-scroll">
      <section className="panel-section">
        <h3 className="section-title">Invite</h3>
        <button className="btn block" onClick={copyLink}>
          <Copy size={16} /> Copy room link
        </button>
      </section>

      <section className="panel-section">
        <h3 className="section-title">
          <Bell size={14} aria-hidden /> Just for you
        </h3>
        {config.dictionary && (
          <Toggle
            checked={personal.dictionary}
            onChange={(v) => updatePersonal({ dictionary: v })}
            label="Define words I select"
            hint={`Select a word in the book to see its meaning (${config.dictionary === 'oxford' ? 'Oxford Dictionaries' : 'built-in English dictionary'}, with a link to Oxford).`}
          />
        )}
        <Toggle checked={personal.sound} onChange={(v) => updatePersonal({ sound: v })} label="Play a sound when it's my turn" />
        {'Notification' in window && (
          <Toggle
            checked={personal.notify}
            onChange={enableNotifications}
            label="Desktop notification when it's my turn"
            hint="Handy when this tab is in the background."
          />
        )}
      </section>

      {view.isMod && (
        <>
          <section className="panel-section">
            <h3 className="section-title">Reading order</h3>
            <Toggle
              checked={settings.rotate}
              onChange={(v) => moderate({ type: 'settings', settings: { rotate: v } })}
              label="Rotate readers"
              hint="After finishing or passing, readers go to the back of the line."
            />
            <Toggle
              checked={settings.queueLocked}
              onChange={(v) => moderate({ type: 'settings', settings: { queueLocked: v } })}
              label="Lock the queue"
              hint="Only moderators can add people to the line."
            />
            <Toggle
              checked={settings.autoSkipOffline}
              onChange={(v) => moderate({ type: 'settings', settings: { autoSkipOffline: v } })}
              label="Skip disconnected readers"
              hint="If the reader's connection drops and they don't come back in time."
            />
            {settings.autoSkipOffline && (
              <label className="field inline">
                <span>Wait before skipping</span>
                <select
                  className="input"
                  value={settings.offlineGraceSeconds}
                  onChange={(e) => moderate({ type: 'settings', settings: { offlineGraceSeconds: Number(e.target.value) } })}
                >
                  {[30, 60, 120, 300, 600].map((s) => (
                    <option key={s} value={s}>
                      {s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? 's' : ''}`}
                    </option>
                  ))}
                  {![30, 60, 120, 300, 600].includes(settings.offlineGraceSeconds) && (
                    <option value={settings.offlineGraceSeconds}>{settings.offlineGraceSeconds} seconds</option>
                  )}
                </select>
              </label>
            )}
          </section>

          <section className="panel-section">
            <h3 className="section-title">Room details</h3>
            <form className="form" onSubmit={saveDetails}>
              <label className="field">
                <span>Name</span>
                <input className="input" value={name} maxLength={LIMITS.roomName} onChange={(e) => setName(e.target.value)} required />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea
                  className="input"
                  rows={3}
                  value={description}
                  maxLength={LIMITS.roomDescription}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <button className="btn" disabled={name === state.name && description === state.description}>
                Save
              </button>
            </form>
          </section>
        </>
      )}

      {(view.role === 'owner' || view.role === 'admin') && (
        <section className="panel-section danger-zone">
          <h3 className="section-title">Danger zone</h3>
          <button className="btn danger block" onClick={deleteRoom}>
            <Trash2 size={16} /> Delete room
          </button>
        </section>
      )}
    </div>
  );
}
