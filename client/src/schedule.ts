/** Helpers for the room's planned next session, always shown in the viewer's own time zone. */

export function formatSession(at: number, now = Date.now()) {
  const date = new Date(at);
  const day = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}${relative(at, now) ? ` (${relative(at, now)})` : ''}`;
}

export function relative(at: number, now = Date.now()) {
  const diff = at - now;
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 1) return 'now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

/** A session is worth showing from now until three hours after it started. */
export function isUpcoming(at: number | null | undefined, now = Date.now()): at is number {
  return typeof at === 'number' && at > now - 3 * 3600_000;
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(at: number) {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Downloads a calendar invite (.ics) for the session. */
export function downloadCalendarInvite(at: number, title: string, url: string) {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escape = (s: string) => s.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Reading Room//EN',
    'BEGIN:VEVENT',
    `UID:${at}-${encodeURIComponent(url)}@reading-room`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(at)}`,
    `DTEND:${stamp(at + 90 * 60_000)}`,
    `SUMMARY:${escape(title)}`,
    `DESCRIPTION:${escape(`Join the reading room: ${url}`)}`,
    `URL:${url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  link.download = 'reading-session.ics';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
