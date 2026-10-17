import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, type SubscriptionStatus, type UserDocument } from './user.schema.js';

/** The account as the web app sees it; never includes secrets. */
export type PublicUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  providers: ('password' | 'google')[];
  subscription: { status: SubscriptionStatus; plan: string | null; currentPeriodEnd: string | null };
  createdAt: string;
};

export type GoogleProfile = { googleId: string; email: string; name: string; avatarUrl: string | null };

const DUPLICATE_KEY = 11000;
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === DUPLICATE_KEY;

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  findById(id: string): Promise<UserDocument | null> {
    return this.users.findById(id).exec();
  }

  /** Includes the password hash, for sign-in checks only. */
  findByEmailWithPassword(email: string): Promise<UserDocument | null> {
    return this.users.findOne({ email: email.toLowerCase() }).select('+passwordHash').exec();
  }

  async existsByEmail(email: string): Promise<boolean> {
    return (await this.users.exists({ email: email.toLowerCase() })) !== null;
  }

  async createWithPassword(email: string, name: string, passwordHash: string, options: { emailVerified: boolean }): Promise<UserDocument> {
    try {
      return await this.users.create({ email, name, passwordHash, hasPassword: true, emailVerified: options.emailVerified });
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException('An account with this email already exists.');
      throw error;
    }
  }

  /**
   * Finds or creates the account for a Google sign-in. `profile.email` must be verified by Google.
   * An existing email account is linked to Google; if that account never proved it owns the email,
   * its password is removed so whoever chose it cannot keep access to the real owner's account.
   */
  async upsertFromGoogle(profile: GoogleProfile): Promise<UserDocument> {
    const linked = await this.users.findOne({ googleId: profile.googleId }).exec();
    if (linked) return linked;

    const existing = await this.users.findOne({ email: profile.email.toLowerCase() }).exec();
    if (existing) {
      if (existing.googleId) throw new ConflictException('This email is already linked to another Google account.');
      existing.googleId = profile.googleId;
      existing.avatarUrl ??= profile.avatarUrl;
      if (!existing.emailVerified) {
        existing.passwordHash = undefined;
        existing.hasPassword = false;
        existing.emailVerified = true;
      }
      return existing.save();
    }

    try {
      return await this.users.create({ ...profile, emailVerified: true });
    } catch (error) {
      // Two sign-ins for the same new account raced; the other one created it.
      if (isDuplicateKey(error)) {
        const created = await this.users.findOne({ googleId: profile.googleId }).exec();
        if (created) return created;
        throw new ConflictException('An account with this email already exists.');
      }
      throw error;
    }
  }

  toPublic(user: UserDocument): PublicUser {
    const providers: PublicUser['providers'] = [];
    if (user.hasPassword) providers.push('password');
    if (user.googleId) providers.push('google');
    return {
      id: user.id as string,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      providers,
      subscription: {
        status: user.subscription?.status ?? 'none',
        plan: user.subscription?.plan ?? null,
        currentPeriodEnd: user.subscription?.currentPeriodEnd?.toISOString() ?? null,
      },
      createdAt: user.createdAt.toISOString(),
    };
  }
}
