// Small DOM helpers. Text always goes in as text, never as HTML.
export function $(sel: string): HTMLElement {
  const e = document.querySelector<HTMLElement>(sel);
  if (!e) throw new Error(`missing ${sel}`);
  return e;
}

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') e.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false) e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** A status box: kind sets colour and glyph (✓ ok, ▲ warn, ✗ bad), and it is announced to screen readers. */
export function status(kind: 'ok' | 'warn' | 'bad' | 'info', text: string): HTMLElement {
  return h('div', { class: `status ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, text);
}

export function show(target: HTMLElement, ...nodes: Child[]) {
  target.replaceChildren(...(nodes.filter(Boolean) as (Node | string)[]));
  const first = target.querySelector<HTMLElement>('h2, [role=alert], input, button');
  if (first && first.tagName === 'H2') {
    first.tabIndex = -1;
    first.focus();
  }
}

export function fragmentParams(): URLSearchParams {
  return new URLSearchParams(location.hash.replace(/^#/, ''));
}

/** Pages read their settings from the fragment once; a link opened in the same tab only changes the fragment. */
export function restartOnNewFragment(): void {
  addEventListener('hashchange', () => location.reload());
}

/** The fragment without the given keys, for history.replaceState. */
export function fragmentWithout(...keys: string[]): string {
  const p = fragmentParams();
  for (const k of keys) p.delete(k);
  const s = p.toString();
  return location.pathname + (s ? `#${s}` : '');
}
