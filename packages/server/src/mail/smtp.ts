// Any SMTP server (Docker target). Amazon SES's SMTP endpoint works with an SES SMTP key.
import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from './types.ts';

export class SmtpMailer implements Mailer {
  private readonly t: Transporter;
  private readonly from: string;
  constructor(opts: { host: string; port: number; user?: string; pass?: string; from: string }) {
    this.t = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      requireTLS: opts.port !== 465 && opts.port !== 25,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
    });
    this.from = opts.from;
  }
  async send(m: MailMessage) {
    await this.t.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}
