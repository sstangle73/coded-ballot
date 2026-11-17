// Talks to the organisation's server with a tool token made on the staff page (passkeys work only in a browser).
export class Server {
  readonly url: string;
  private readonly token: string | null;
  constructor(url: string, token: string | null) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }
  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? `HTTP ${res.status}`}`);
    return json as T;
  }
}
