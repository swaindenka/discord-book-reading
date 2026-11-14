import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, LogIn, Users, ListOrdered, MessageSquare } from 'lucide-react';
import { api } from '../api';
import { navigate, useDocumentTitle, useLocation } from '../router';
import { useSession } from '../session';

const ERRORS: Record<string, string> = {
  not_member: 'You need to be a member of our Discord community to sign in.',
  denied: 'Discord sign-in was cancelled.',
  state: 'That sign-in attempt expired. Please try again.',
  oauth_failed: 'Discord sign-in failed. Please try again in a moment.',
  discord_disabled: "Discord sign-in isn't set up on this server yet.",
};

function safeReturnTo(value: string | null) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function LoginPage() {
  const { config, user, refresh } = useSession();
  const { search } = useLocation();
  const returnTo = safeReturnTo(search.get('returnTo'));
  const error = search.get('error');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [devError, setDevError] = useState<string | null>(null);
  useDocumentTitle(`Sign in · ${config.appName}`);

  useEffect(() => {
    if (user) navigate(returnTo, { replace: true });
  }, [user, returnTo]);

  const devLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setDevError(null);
    try {
      await api.devLogin(name);
      await refresh();
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand-mark large" aria-hidden>
          <BookOpen size={30} />
        </div>
        <h1>{config.appName}</h1>
        <p className="lead">Read books together. One shared page, a fair reading queue, and a chat for everyone listening.</p>

        <ul className="feature-list">
          <li>
            <BookOpen size={16} aria-hidden /> PDF, EPUB, TXT, Markdown and comics, synced for everyone
          </li>
          <li>
            <ListOrdered size={16} aria-hidden /> Take turns reading with a queue — pass when you'd rather listen
          </li>
          <li>
            <Users size={16} aria-hidden /> One spot per Discord account, moderators keep things tidy
          </li>
          <li>
            <MessageSquare size={16} aria-hidden /> Chat alongside the book
          </li>
        </ul>

        {error && (
          <div className="alert error" role="alert">
            {ERRORS[error] ?? 'Sign-in failed. Please try again.'}
          </div>
        )}

        {config.discordLogin && (
          <a className="btn discord block" href={`/auth/discord?returnTo=${encodeURIComponent(returnTo)}`}>
            <LogIn size={18} aria-hidden /> Continue with Discord
          </a>
        )}
        {config.discordLogin && config.guildRestricted && (
          <p className="muted small center">Sign-in is limited to members of our Discord community.</p>
        )}

        {config.devLogin && (
          <form className="dev-login" onSubmit={devLogin}>
            <div className="divider">
              <span>{config.discordLogin ? 'or, for testing' : 'Developer login'}</span>
            </div>
            <p className="muted small">
              Discord sign-in isn't configured{config.discordLogin ? ' for this form' : ''}. Pick any name to try things out —
              don't use this on a public site.
            </p>
            <div className="row">
              <input
                className="input"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                aria-label="Your name"
              />
              <button className="btn primary" disabled={busy || name.trim().length < 2}>
                Enter
              </button>
            </div>
            {devError && <div className="alert error small">{devError}</div>}
          </form>
        )}

        {!config.discordLogin && !config.devLogin && (
          <div className="alert error">Sign-in is not configured on this server.</div>
        )}
      </div>
    </div>
  );
}
