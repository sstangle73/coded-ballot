// Lob's letters API (https://docs.lob.com/#tag/Letters): one letter per member with our own PDF, First-Class, and a
// return envelope (Lob's come without postage). A test key (test_...) makes Lob accept and render the letter but
// send nothing. Lob sees names, addresses and codes together: TRUST.md lists the mail service for that reason.
export interface LobAddress {
  name: string;
  address_line1: string;
  address_line2?: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  address_country?: string;
}

export interface LobResult {
  id: string;
  url?: string;
  expected_delivery_date?: string;
}

export async function sendLobLetter(opts: {
  apiKey: string;
  to: LobAddress;
  from: LobAddress;
  pdf: Uint8Array;
  description: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}): Promise<LobResult> {
  if (!/^(test|live)_[A-Za-z0-9]+$/.test(opts.apiKey)) throw new Error('That doesn’t look like a Lob API key.');
  const form = new FormData();
  const put = (prefix: string, a: LobAddress) => {
    for (const [k, v] of Object.entries(a)) if (v) form.append(`${prefix}[${k}]`, v);
  };
  put('to', opts.to);
  put('from', opts.from);
  form.append('file', new Blob([opts.pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), 'packet.pdf');
  form.append('color', 'false');
  form.append('double_sided', 'false');
  form.append('use_type', 'operational');
  form.append('mail_type', 'usps_first_class');
  // Lob prints its own address page first, so our pages need no reserved address area.
  form.append('address_placement', 'insert_blank_page');
  form.append('return_envelope', 'true');
  // Lob requires a perforated page with a return envelope. It counts our pages (its inserted address page doesn't count),
  // so 1 is the cover letter: never a ballot sheet, which a tear across its ovals or corner squares could leave unreadable.
  form.append('perforated_page', '1');
  form.append('description', opts.description.slice(0, 255));
  const res = await (opts.fetchImpl ?? fetch)('https://api.lob.com/v1/letters', {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${opts.apiKey}:`), 'idempotency-key': opts.idempotencyKey },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; url?: string; expected_delivery_date?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(`Lob refused the letter: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return { id: json.id, url: json.url, expected_delivery_date: json.expected_delivery_date };
}
