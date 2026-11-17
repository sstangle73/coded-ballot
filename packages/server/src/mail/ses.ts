// Amazon SES over its HTTPS API (v2 SendEmail), for Workers, which can't open SMTP connections. aws4fetch signs the
// request (SigV4) with WebCrypto.
import { AwsClient } from 'aws4fetch';
import type { Mailer, MailMessage } from './types.ts';

export class SesApiMailer implements Mailer {
  private readonly aws: AwsClient;
  private readonly region: string;
  private readonly from: string;
  constructor(opts: { accessKeyId: string; secretAccessKey: string; region: string; from: string }) {
    this.aws = new AwsClient({ accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, service: 'ses', region: opts.region });
    this.region = opts.region;
    this.from = opts.from;
  }
  async send(m: MailMessage) {
    const res = await this.aws.fetch(`https://email.${this.region}.amazonaws.com/v2/email/outbound-emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [m.to] },
        Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } } } },
      }),
    });
    if (!res.ok) throw new Error(`SES refused the message: HTTP ${res.status}`);
  }
}
