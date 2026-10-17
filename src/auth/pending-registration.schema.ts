import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * A sign-up waiting for its emailed code. The account is only created once the code is entered,
 * so unverified emails never become accounts. One per email; deleted automatically when it expires.
 */
@Schema({ timestamps: true })
export class PendingRegistration {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  name: string;

  /** Argon2id hash of the chosen password; null when the email already has an account (no code was sent). */
  @Prop({ type: String, default: null })
  passwordHash: string | null;

  /** HMAC-SHA256 of the current code; null when no code was sent. */
  @Prop({ type: String, default: null })
  codeHash: string | null;

  @Prop({ required: true })
  codeExpiresAt: Date;

  /** Wrong guesses against the current code. */
  @Prop({ default: 0 })
  attempts: number;

  @Prop({ required: true })
  lastSentAt: Date;

  /** Emails sent for this sign-up, to cap resends. */
  @Prop({ default: 1 })
  sendCount: number;

  /** MongoDB deletes the document once this passes (TTL index below). */
  @Prop({ required: true })
  expiresAt: Date;
}

export type PendingRegistrationDocument = HydratedDocument<PendingRegistration>;
export const PendingRegistrationSchema = SchemaFactory.createForClass(PendingRegistration);
PendingRegistrationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
