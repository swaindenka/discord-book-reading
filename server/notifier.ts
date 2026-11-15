/**
 * Posts room events to a Discord channel through a webhook
 * (Channel settings → Integrations → Webhooks → Copy Webhook URL).
 */

const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,200}$/;

export interface NotifierConfig {
  appName: string;
  publicUrl: string;
  /** Extra allowed URL prefixes (tests point this at a local fake). */
  extraWebhookPrefixes: string[];
}

export interface Notification {
  content: string;
  /** Discord user IDs that may actually be pinged by this message. */
  mentionUserIds?: string[];
}

/** Escapes Discord markdown in user-supplied names. */
export function escapeMarkdown(text: string) {
  return text.replace(/([\\*_~`|>#[\]()-])/g, '\\$1').replace(/@/g, '@\u200b');
}

export class Notifier {
  /** Recent send times per webhook, to stay well inside Discord's rate limits. */
  private recent = new Map<string, number[]>();

  constructor(private readonly config: NotifierConfig) {}

  isValidUrl(url: string) {
    return DISCORD_WEBHOOK.test(url) || this.config.extraWebhookPrefixes.some((p) => p && url.startsWith(p));
  }

  roomLink(roomId: string) {
    return `${this.config.publicUrl}/room/${roomId}`;
  }

  /**
   * Sends a message. Resolves with null on success or a short error description.
   * Messages beyond 5 per 10 seconds for one webhook are dropped, except when `force` is set.
   */
  async send(url: string, message: Notification, { force = false } = {}): Promise<string | null> {
    const now = Date.now();
    const recent = (this.recent.get(url) ?? []).filter((t) => now - t < 10_000);
    if (!force && recent.length >= 5) return 'rate limited';
    recent.push(now);
    this.recent.set(url, recent);

    const body = JSON.stringify({
      content: message.content.slice(0, 1900),
      username: this.config.appName.slice(0, 80),
      allowed_mentions: { parse: [], users: (message.mentionUserIds ?? []).slice(0, 10) },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) return null;
        if (res.status === 429 && attempt === 0) {
          const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
          await new Promise((r) => setTimeout(r, Math.min(5, Number(data.retry_after) || 1) * 1000));
          continue;
        }
        return res.status === 404 ? 'the webhook was deleted in Discord' : `Discord answered ${res.status}`;
      } catch (err) {
        return (err as Error).name === 'TimeoutError' ? 'Discord did not answer in time' : 'could not reach Discord';
      }
    }
    return 'rate limited by Discord';
  }
}
