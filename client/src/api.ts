import type { AppConfig, DictionaryResult, PublicUser, RoomSummary, SiteAdmin } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'reading-room' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

/** Upload with progress events (fetch can't report upload progress). */
function upload<T>(url: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Requested-With', 'reading-room');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const data = (xhr.response ?? {}) as { error?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(data.error ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Network error during upload.', 0));
    xhr.send(form);
  });
}

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),
  me: () => request<{ user: PublicUser | null }>('GET', '/api/me'),
  devLogin: (name: string) => request<{ user: PublicUser }>('POST', '/auth/dev', { name }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  rooms: () => request<{ rooms: RoomSummary[] }>('GET', '/api/rooms'),
  createRoom: (form: FormData, onProgress?: (f: number) => void) => upload<{ id: string }>('/api/rooms', form, onProgress),
  deleteRoom: (roomId: string) => request<{ ok: true }>('DELETE', `/api/rooms/${roomId}`),
  uploadBook: (roomId: string, form: FormData, onProgress?: (f: number) => void) =>
    upload<{ id: string }>(`/api/rooms/${roomId}/books`, form, onProgress),
  deleteBook: (roomId: string, bookId: string) => request<{ ok: true }>('DELETE', `/api/rooms/${roomId}/books/${bookId}`),
  bookUrl: (bookId: string) => `/api/books/${bookId}/file`,
  define: (word: string) => request<DictionaryResult>('GET', `/api/dictionary?word=${encodeURIComponent(word)}`),
  admins: () => request<{ admins: SiteAdmin[] }>('GET', '/api/admins'),
  addAdmin: (userId: string) => request<{ admins: SiteAdmin[] }>('POST', '/api/admins', { userId }),
  removeAdmin: (userId: string) => request<{ admins: SiteAdmin[] }>('DELETE', `/api/admins/${encodeURIComponent(userId)}`),
};
