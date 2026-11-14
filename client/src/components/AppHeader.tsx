import type { ReactNode } from 'react';
import { BookOpen, LogOut, ShieldCheck } from 'lucide-react';
import { Link, navigate } from '../router';
import { useSession } from '../session';
import { Avatar, Menu, MenuItem } from './ui';

export function UserMenu() {
  const { user, logout } = useSession();
  if (!user) return null;
  return (
    <Menu label="Account" trigger={<Avatar id={user.id} name={user.name} url={user.avatarUrl} size={30} />}>
      {(close) => (
        <>
          <div className="menu-header">
            <strong>{user.name}</strong>
            <span className="muted small">@{user.username}</span>
            {user.isAdmin && (
              <span className="pill small">
                <ShieldCheck size={12} /> Site admin
              </span>
            )}
          </div>
          <MenuItem
            icon={<LogOut size={16} />}
            onClick={async () => {
              close();
              await logout();
              navigate('/login');
            }}
          >
            Sign out
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

export function AppHeader({ children }: { children?: ReactNode }) {
  const { config } = useSession();
  return (
    <header className="app-header">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden>
          <BookOpen size={18} />
        </span>
        <span className="brand-name">{config.appName}</span>
      </Link>
      <div className="header-slot">{children}</div>
      <UserMenu />
    </header>
  );
}
