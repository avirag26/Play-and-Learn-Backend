import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export const subscriptionStatuses = ['none', 'trialing', 'active', 'past_due', 'canceled'] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

/** Billing state for the account. Payments will update this; sign-in only reads it. */
@Schema({ _id: false })
export class Subscription {
  @Prop({ type: String, enum: subscriptionStatuses, default: 'none' })
  status: SubscriptionStatus;

  @Prop({ type: String, default: null })
  plan: string | null;

  @Prop({ type: Date, default: null })
  currentPeriodEnd: Date | null;
}
const SubscriptionSchema = SchemaFactory.createForClass(Subscription);

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, trim: true })
  name: string;

  /** Argon2id hash; absent for accounts that only sign in with Google. */
  @Prop({ type: String, select: false })
  passwordHash?: string;

  /** Whether a password is set; readable without loading the hash. */
  @Prop({ default: false })
  hasPassword: boolean;

  /** Google's stable account id (the ID token's `sub`). */
  @Prop({ type: String, unique: true, sparse: true })
  googleId?: string;

  @Prop({ type: String, default: null })
  avatarUrl: string | null;

  @Prop({ default: false })
  emailVerified: boolean;

  @Prop({ type: SubscriptionSchema, default: () => ({}) })
  subscription: Subscription;

  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
