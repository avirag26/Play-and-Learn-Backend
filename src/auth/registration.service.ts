import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { Model } from 'mongoose';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env.js';
import { describeError, MailService } from '../mail/mail.service.js';
import type { UserDocument } from '../users/user.schema.js';
import { UsersService } from '../users/users.service.js';
import type { RegisterDto } from './dto/auth.dto.js';
import { PendingRegistration } from './pending-registration.schema.js';

export const CODE_TTL_SECONDS = 10 * 60;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_SENDS = 5;
/** How long a sign-up may stay pending, across resends. */
const PENDING_TTL_SECONDS = 60 * 60;

/** What the web app needs to show the "enter your code" step. Identical whether or not the email already has an account. */
export type CodeSent = { email: string; expiresIn: number; resendIn: number };

const EXPIRED = 'This code has expired. Request a new one.';

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    @InjectModel(PendingRegistration.name) private readonly pending: Model<PendingRegistration>,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Step 1: remember the sign-up and email a 6-digit code. Nothing is created until the code is confirmed. */
  async start(dto: RegisterDto): Promise<CodeSent> {
    const existing = await this.pending.findOne({ email: dto.email }).exec();
    if (existing) this.assertCooldownPassed(existing.lastSentAt);

    const now = new Date();
    const taken = await this.users.existsByEmail(dto.email);
    // An existing account gets a "you already have an account" email instead of a code, and the
    // response is the same, so sign-up cannot be used to discover who is registered.
    const code = taken ? null : this.newCode();
    const passwordHash = taken ? null : await argon2.hash(dto.password, { type: argon2.argon2id });
    await this.pending
      .findOneAndUpdate(
        { email: dto.email },
        {
          $set: { name: dto.name, passwordHash, codeHash: code && this.hashCode(dto.email, code), codeExpiresAt: this.secondsFromNow(CODE_TTL_SECONDS, now), attempts: 0, lastSentAt: now, sendCount: 1, expiresAt: this.secondsFromNow(PENDING_TTL_SECONDS, now) },
        },
        { upsert: true, setDefaultsOnInsert: true },
      )
      .exec();

    await this.deliver(dto.email, () => (code ? this.mail.sendSignUpCode(dto.email, dto.name, code, CODE_TTL_SECONDS / 60) : this.mail.sendAlreadyRegistered(dto.email)));
    return this.codeSent(dto.email);
  }

  /** Emails a fresh code for a pending sign-up. Unknown emails get the same answer and no email. */
  async resend(email: string): Promise<CodeSent> {
    const pending = await this.pending.findOne({ email }).exec();
    if (!pending) return this.codeSent(email);
    this.assertCooldownPassed(pending.lastSentAt);
    if (pending.sendCount >= MAX_SENDS) throw new HttpException('Too many codes sent. Please start again in an hour.', HttpStatus.TOO_MANY_REQUESTS);

    const now = new Date();
    const code = pending.passwordHash ? this.newCode() : null;
    const updated = await this.pending
      .findOneAndUpdate(
        { _id: pending._id, lastSentAt: pending.lastSentAt },
        { $set: { codeHash: code && this.hashCode(email, code), codeExpiresAt: this.secondsFromNow(CODE_TTL_SECONDS, now), attempts: 0, lastSentAt: now }, $inc: { sendCount: 1 } },
      )
      .exec();
    // Another resend won the race and already emailed a code.
    if (!updated) throw new HttpException(`Please wait ${RESEND_COOLDOWN_SECONDS} seconds before asking for another code.`, HttpStatus.TOO_MANY_REQUESTS);

    await this.deliver(email, () => (code ? this.mail.sendSignUpCode(email, pending.name, code, CODE_TTL_SECONDS / 60) : this.mail.sendAlreadyRegistered(email)));
    return this.codeSent(email);
  }

  /** Step 2: check the code and create the account. Each code allows {@link MAX_CODE_ATTEMPTS} wrong guesses. */
  async verify(email: string, code: string): Promise<UserDocument> {
    const pending = await this.pending.findOne({ email }).exec();
    if (!pending?.codeHash || !pending.passwordHash || pending.codeExpiresAt.getTime() < Date.now()) throw new BadRequestException(EXPIRED);
    if (pending.attempts >= MAX_CODE_ATTEMPTS) throw new BadRequestException('Too many wrong codes. Request a new one.');

    if (!this.sameHash(pending.codeHash, this.hashCode(email, code))) {
      // Counted atomically, so parallel guesses cannot exceed the limit.
      const counted = await this.pending.findOneAndUpdate({ _id: pending._id, codeHash: pending.codeHash, attempts: { $lt: MAX_CODE_ATTEMPTS } }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).exec();
      const left = counted ? MAX_CODE_ATTEMPTS - counted.attempts : 0;
      throw new BadRequestException(left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Request a new one.');
    }

    // Deleting first makes the code single-use even if it is submitted twice at once.
    const claimed = await this.pending.findOneAndDelete({ _id: pending._id, codeHash: pending.codeHash }).exec();
    if (!claimed?.passwordHash) throw new BadRequestException(EXPIRED);
    try {
      return await this.users.createWithPassword(claimed.email, claimed.name, claimed.passwordHash, { emailVerified: true });
    } catch (error) {
      if (error instanceof ConflictException) throw new ConflictException('This email already has an account. Please sign in.');
      throw error;
    }
  }

  /** Sends the email; if that fails, lifts the cooldown so the parent can try again straight away. */
  private async deliver(email: string, send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.error(`Could not send the sign-up email to ${email} (${describeError(error)})`);
      await this.pending.updateOne({ email }, { $set: { lastSentAt: new Date(0) } }).exec();
      throw new ServiceUnavailableException("We couldn't send the email. Please try again in a moment.");
    }
  }

  private codeSent(email: string): CodeSent {
    return { email, expiresIn: CODE_TTL_SECONDS, resendIn: RESEND_COOLDOWN_SECONDS };
  }

  private assertCooldownPassed(lastSentAt: Date): void {
    const wait = Math.ceil((lastSentAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000);
    if (wait > 0) throw new HttpException(`Please wait ${wait} seconds before asking for another code.`, HttpStatus.TOO_MANY_REQUESTS);
  }

  private newCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /** Bound to the email, so a code hash cannot be moved to another sign-up. */
  private hashCode(email: string, code: string): string {
    return createHmac('sha256', this.config.get('OTP_SECRET', { infer: true })).update(`${email}:${code}`).digest('hex');
  }

  private sameHash(a: string, b: string): boolean {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  private secondsFromNow(seconds: number, now: Date): Date {
    return new Date(now.getTime() + seconds * 1000);
  }
}
