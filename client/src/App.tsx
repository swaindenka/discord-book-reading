import { useEffect } from 'react';
import { matchRoute, navigate, useLocation, Link } from './router';
import { useSession } from './session';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { RoomPage } from './pages/RoomPage';

export function App() {
  const { user } = useSession();
  const location = useLocation();
  const route = matchRoute(location.pathname);

  const needsLogin = !user && route.name !== 'login';
  useEffect(() => {
    if (needsLogin) {
      const returnTo = location.pathname + (location.search.toString() ? `?${location.search}` : '');
      navigate(`/login${returnTo !== '/' ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`, { replace: true });
    }
  }, [needsLogin, location.pathname, location.search]);

  if (needsLogin) return null;

  switch (route.name) {
    case 'login':
      return <LoginPage />;
    case 'home':
      return <HomePage />;
    case 'room':
      return <RoomPage key={route.roomId} roomId={route.roomId} />;
    default:
      return (
        <div className="center-screen">
          <div className="card narrow">
            <h1>Page not found</h1>
            <p className="muted">That link doesn't lead anywhere.</p>
            <Link className="btn primary" href="/">
              Back to rooms
            </Link>
          </div>
        </div>
      );
  }
}
