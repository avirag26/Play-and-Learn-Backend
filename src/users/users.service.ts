import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, type SubscriptionStatus, type UserDocument, type UserRole } from './user.schema.js';

/** The account as the web app sees it; never includes secrets. */
export type PublicUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  providers: ('password' | 'google')[];
  role: UserRole;
  isAdmin: boolean;
  subscription: { status: SubscriptionStatus; plan: string | null; currentPeriodEnd: string | null };
  createdAt: string;
};

export type GoogleProfile = { googleId: string; email: string; name: string; avatarUrl: string | null };

const DUPLICATE_KEY = 11000;
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === DUPLICATE_KEY;

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  isAdmin(user: UserDocument): boolean {
    return user.role === 'admin';
  }

  /** Creates an admin account directly (no emailed code: whoever runs this has server access). */
  async createAdmin(email: string, name: string, passwordHash: string): Promise<UserDocument> {
    try {
      return await this.users.create({ email, name, passwordHash, hasPassword: true, emailVerified: true, role: 'admin' });
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException(`${email} already has an account. Promote it instead.`);
      throw error;
    }
  }

  /** Returns the updated account, or null when no account has this email. */
  setRole(email: string, role: UserRole): Promise<UserDocument | null> {
    return this.users.findOneAndUpdate({ email: email.toLowerCase() }, { $set: { role } }, { returnDocument: 'after' }).exec();
  }

  listAdmins(): Promise<UserDocument[]> {
    return this.users.find({ role: 'admin' }).sort({ email: 1 }).exec();
  }

  /** "expired" once an active period has ended. */
  subscriptionStatus(user: UserDocument, now = new Date()): SubscriptionStatus {
    if (user.subscription?.status !== 'active') return 'none';
    return user.subscription.currentPeriodEnd && user.subscription.currentPeriodEnd > now ? 'active' : 'expired';
  }

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

  /**
   * Adds `days` of Premium: from the current end date if still active, otherwise from now.
   * A single atomic update, so two payments confirmed at the same moment both count.
   */
  async extendPremium(userId: string, planName: string, days: number, now = new Date()): Promise<void> {
    await this.users
      .updateOne({ _id: userId }, [
        {
          $set: {
            'subscription.status': 'active',
            'subscription.plan': planName,
            'subscription.currentPeriodEnd': { $add: [{ $max: [{ $ifNull: ['$subscription.currentPeriodEnd', now] }, now] }, days * 24 * 60 * 60 * 1000] },
          },
        },
      ], { updatePipeline: true })
      .exec();
  }

  countActivePremium(now = new Date()): Promise<number> {
    return this.users.countDocuments({ 'subscription.status': 'active', 'subscription.currentPeriodEnd': { $gt: now } }).exec();
  }

  /** id → email, for admin lists. */
  async emailsByIds(ids: readonly string[]): Promise<Map<string, string>> {
    const found = await this.users.find({ _id: { $in: ids } }, { email: 1 }).lean().exec();
    return new Map(found.map((user) => [String(user._id), user.email]));
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
      role: user.role ?? 'user',
      isAdmin: this.isAdmin(user),
      subscription: {
        status: this.subscriptionStatus(user),
        plan: user.subscription?.plan ?? null,
        currentPeriodEnd: user.subscription?.currentPeriodEnd?.toISOString() ?? null,
      },
      createdAt: user.createdAt.toISOString(),
    };
  }
}
