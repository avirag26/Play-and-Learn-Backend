import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';

/**
 * One issued refresh token. Each sign-in starts a `family`; every refresh replaces the current token
 * with a new one in the same family. Presenting a replaced token again means it was copied, so the
 * whole family is revoked.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class RefreshToken {
  /** The token's `jti` claim. */
  @Prop({ required: true, unique: true })
  jti: string;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, index: true })
  family: string;

  /** SHA-256 of the signed token, so a database leak cannot be replayed. */
  @Prop({ required: true })
  tokenHash: string;

  /** MongoDB deletes the document once this passes (TTL index below). */
  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  /** The `jti` that replaced this token on refresh. */
  @Prop({ type: String, default: null })
  replacedBy: string | null;

  @Prop({ type: String, default: null })
  userAgent: string | null;

  @Prop({ type: String, default: null })
  ip: string | null;

  createdAt: Date;
}

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;
export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
