// The organisation's server. Its address comes from the link's # part (never sent to any server), or this page's
// own origin when the page is served by the organisation's server itself.
export class Api {
  readonly base: string;
  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }
  async get<T = any>(path: string): Promise<T> {
    return this.req<T>('GET', path);
  }
  async post<T = any>(path: string, body?: unknown): Promise<T> {
    return this.req<T>('POST', path, body);
  }
  async req<T>(method: string, path: string, body?: unknown, raw?: { data: Blob | Uint8Array; type: string }): Promise<T> {
    const init: RequestInit = { method, credentials: this.base === location.origin ? 'same-origin' : 'omit', headers: {} };
    if (raw) {
      (init.headers as Record<string, string>)['content-type'] = raw.type;
      init.body = raw.data as BodyInit;
    } else if (body !== undefined) {
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(this.base + path, init);
    } catch {
      throw new Error(`Couldn't reach ${this.base}. Check your connection and try again.`);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw Object.assign(new Error(json.error ?? `The server answered ${res.status}.`), { status: res.status });
    return json as T;
  }
}

export function serverFromFragment(p: URLSearchParams): string {
  const s = p.get('s');
  if (!s) return location.origin;
  const u = new URL(s);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('The server address must use https.');
  return u.origin;
}
