import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export const userRoles = ['user', 'admin'] as const;
export type UserRole = (typeof userRoles)[number];

/** Stored states. "expired" is never stored: it is an active subscription whose period has ended (see UsersService.toPublic). */
export const subscriptionStatuses = ['none', 'active'] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number] | 'expired';

/** Premium access: each payment extends `currentPeriodEnd` by the plan's duration. */
@Schema({ _id: false })
export class Subscription {
  @Prop({ type: String, enum: subscriptionStatuses, default: 'none' })
  status: (typeof subscriptionStatuses)[number];

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

  /** "admin" can use the admin app. Changed only with `npm run admin` on the server, never through the API. */
  @Prop({ type: String, enum: userRoles, default: 'user', index: true })
  role: UserRole;

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
