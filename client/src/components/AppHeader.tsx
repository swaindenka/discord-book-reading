import { useCallback, useState, type ReactNode } from 'react';
import { BookOpen, LogOut, ShieldCheck, UserCog } from 'lucide-react';
import { Link, navigate } from '../router';
import { useSession } from '../session';
import { Avatar, Menu, MenuItem } from './ui';
import { SiteAdminsDialog } from './SiteAdmins';

export function UserMenu() {
  const { user, logout } = useSession();
  const [adminsOpen, setAdminsOpen] = useState(false);
  const closeAdmins = useCallback(() => setAdminsOpen(false), []);
  if (!user) return null;
  return (
    <>
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
            {user.isAdmin && (
              <MenuItem
                icon={<UserCog size={16} />}
                onClick={() => {
                  close();
                  setAdminsOpen(true);
                }}
              >
                Site admins
              </MenuItem>
            )}
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
      {adminsOpen && <SiteAdminsDialog onClose={closeAdmins} />}
    </>
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
