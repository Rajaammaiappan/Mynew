/** Tiny API client: token pair persistence + one automatic refresh retry. */
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Session {
  apiUrl: string;
  access: string;
  refresh: string;
  user: { id: string; handle: string };
}

let session: Session | null = null;

export const getSession = () => session;

export async function loadSession(): Promise<Session | null> {
  const raw = await AsyncStorage.getItem('session');
  session = raw ? JSON.parse(raw) : null;
  return session;
}

export async function saveSession(s: Session | null) {
  session = s;
  if (s) await AsyncStorage.setItem('session', JSON.stringify(s));
  else await AsyncStorage.removeItem('session');
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, detail: string) {
    super(detail);
  }
}

async function raw(apiUrl: string, path: string, opts: RequestInit = {}, access?: string) {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/v1${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(access ? { authorization: `Bearer ${access}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.code ?? 'UNKNOWN', body?.detail ?? body?.message ?? `HTTP ${res.status}`);
  return body;
}

/** Unauthenticated call (login flow). */
export const anon = (apiUrl: string, path: string, opts: RequestInit = {}) => raw(apiUrl, path, opts);

/** Authenticated call with single refresh-and-retry on 401. */
export async function api(path: string, opts: RequestInit = {}) {
  if (!session) throw new ApiError(401, 'NO_SESSION', 'Not logged in');
  try {
    return await raw(session.apiUrl, path, opts, session.access);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const t = await raw(session.apiUrl, '/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh: session.refresh }),
    });
    session = { ...session, access: t.access, refresh: t.refresh };
    await saveSession(session);
    return raw(session.apiUrl, path, opts, session.access);
  }
}

export const wsUrl = () =>
  session ? `${session.apiUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/rt?token=${session.access}` : null;
