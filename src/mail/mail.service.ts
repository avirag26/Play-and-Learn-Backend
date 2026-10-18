import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';

export type MailMessage = { to: string; subject: string; text: string; html: string };

/** Network errors such as ETIMEDOUT can have an empty message; fall back to their code. */
export const describeError = (error: unknown): string => {
  const { message, code } = (error ?? {}) as { message?: string; code?: string };
  return [code, message].filter(Boolean).join(': ') || String(error);
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function layout(body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#fff9ec;font-family:Arial,Helvetica,sans-serif;color:#30465d">
<div style="max-width:480px;margin:0 auto;padding:32px 24px">
<p style="font-size:20px;font-weight:bold;margin:0 0 24px">Play &amp; Learn</p>
<div style="background:#ffffff;border-radius:20px;padding:28px">${body}</div>
<p style="font-size:12px;color:#6c7e8e;margin-top:24px">You received this email because this address was used in the Play &amp; Learn parent area.</p>
</div></body></html>`;
}

/** Sends account emails over SMTP. Without SMTP (development only) it prints them to the console instead. */
@Injectable()
export class MailService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    this.from = config.get('MAIL_FROM', { infer: true });
    const host = config.get('SMTP_HOST', { infer: true });
    const user = config.get('SMTP_USER', { infer: true });
    this.transporter = host
      ? nodemailer.createTransport({
          host,
          port: config.get('SMTP_PORT', { infer: true }),
          secure: config.get('SMTP_SECURE', { infer: true }) === 'true',
          auth: user ? { user, pass: config.get('SMTP_PASS', { infer: true }) } : undefined,
        })
      : null;
    if (!this.transporter) this.logger.warn('SMTP_HOST is not set: emails will be printed to this console instead of being sent.');
  }

  /** Logs in to the SMTP server once at startup, so wrong settings show up now rather than at the first sign-up. Never blocks startup. */
  onApplicationBootstrap(): void {
    this.transporter?.verify().then(
      () => this.logger.log('SMTP connection verified: sign-up codes will be emailed.'),
      (error: unknown) => this.logger.error(`SMTP check failed (${describeError(error)}). Sign-up emails will fail until this is fixed.`),
    );
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`\n--- Email (not sent: SMTP is not configured) ---\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n---`);
      return;
    }
    await this.transporter.sendMail({ from: this.from, ...message });
  }

  sendSignUpCode(to: string, name: string, code: string, minutesValid: number): Promise<void> {
    return this.send({
      to,
      subject: `${code} is your Play & Learn code`,
      text: `Hi ${name},\n\nYour Play & Learn sign-up code is: ${code}\n\nIt expires in ${minutesValid} minutes. If you didn't try to create an account, you can ignore this email.`,
      html: layout(`<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
<p style="margin:0 0 20px">Enter this code to finish creating your parent account:</p>
<p style="font-size:34px;font-weight:bold;letter-spacing:8px;margin:0 0 20px;font-family:'Courier New',monospace">${code}</p>
<p style="margin:0;color:#6c7e8e">It expires in ${minutesValid} minutes. If you didn't try to create an account, you can ignore this email.</p>`),
    });
  }

  /** Sent instead of a code when the address already has an account, so sign-up never reveals which emails are registered. */
  sendAlreadyRegistered(to: string): Promise<void> {
    return this.send({
      to,
      subject: 'You already have a Play & Learn account',
      text: `Someone tried to create a Play & Learn account with this email, but you already have one.\n\nSign in instead (with your password, or "Continue with Google" if you used Google). If this wasn't you, you can ignore this email.`,
      html: layout(`<p style="margin:0 0 12px">Someone tried to create a Play &amp; Learn account with this email, but <strong>you already have one</strong>.</p>
<p style="margin:0 0 12px">Sign in instead, with your password or with <em>Continue with Google</em> if you used Google.</p>
<p style="margin:0;color:#6c7e8e">If this wasn't you, you can ignore this email.</p>`),
    });
  }

  /** Confirms a deletion, so the parent knows if someone else did it. */
  sendAccountDeleted(to: string, name: string): Promise<void> {
    return this.send({
      to,
      subject: 'Your Play & Learn account has been deleted',
      text: `Hi ${name},

Your Play & Learn parent account and its personal information have been deleted, as you asked. Any Premium time on it has ended.

Your child's game progress was only ever saved on your device, so it is still there.

If you didn't ask for this, reply to this email straight away.`,
      html: layout(`<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
<p style="margin:0 0 12px">Your Play &amp; Learn parent account and its personal information <strong>have been deleted</strong>, as you asked. Any Premium time on it has ended.</p>
<p style="margin:0 0 12px">Your child's game progress was only ever saved on your device, so it is still there.</p>
<p style="margin:0;color:#6c7e8e">If you didn't ask for this, reply to this email straight away.</p>`),
    });
  }
}
