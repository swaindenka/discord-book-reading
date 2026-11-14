import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

// A tiny history-based router: the app only has three screens.

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

const getLocation = () => window.location.pathname + window.location.search;

export function navigate(to: string, { replace = false } = {}) {
  if (to === getLocation()) return;
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  listeners.forEach((l) => l());
}

export function useLocation() {
  const href = useSyncExternalStore(subscribe, getLocation);
  const url = new URL(href, window.location.origin);
  return { pathname: url.pathname, search: url.searchParams, href };
}

export type Route = { name: 'home' } | { name: 'login' } | { name: 'room'; roomId: string } | { name: 'notFound' };

export function matchRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' };
  if (pathname === '/login') return { name: 'login' };
  const room = pathname.match(/^\/room\/([a-z0-9]{4,16})\/?$/i);
  if (room) return { name: 'room', roomId: room[1] };
  return { name: 'notFound' };
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
