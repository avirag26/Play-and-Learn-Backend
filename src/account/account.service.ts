import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { Model, Types } from 'mongoose';
import { PendingRegistration } from '../auth/pending-registration.schema.js';
import { RefreshToken } from '../auth/refresh-token.schema.js';
import { Payment } from '../billing/payment.schema.js';
import { describeError, MailService } from '../mail/mail.service.js';
import { UsersService } from '../users/users.service.js';

export type DeleteAccountProof = { password?: string; email?: string };

/**
 * Deletes a parent account and every piece of personal information tied to it. Payment records are
 * kept for accounting but unlinked, so nothing in them points to a person any more.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly users: UsersService,
    private readonly mail: MailService,
    @InjectModel(RefreshToken.name) private readonly refreshTokens: Model<RefreshToken>,
    @InjectModel(PendingRegistration.name) private readonly pendingRegistrations: Model<PendingRegistration>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
  ) {}

  /** Password accounts confirm with their password; Google-only accounts type their email address. */
  async deleteAccount(userId: string, proof: DeleteAccountProof): Promise<void> {
    const user = await this.users.findByIdWithPassword(userId);
    if (!user) throw new UnauthorizedException('Please sign in.');

    if (user.passwordHash) {
      if (!proof.password) throw new BadRequestException('Enter your password to delete your account.');
      // 403, not 401: the session is fine, and the web app retries 401s by refreshing the session.
      if (!(await argon2.verify(user.passwordHash, proof.password).catch(() => false))) throw new ForbiddenException('That password is incorrect.');
    } else if (proof.email?.trim().toLowerCase() !== user.email) {
      throw new BadRequestException('Type your email address exactly to confirm.');
    }
    // Never leave the admin app without anyone who can sign in to it.
    if (user.role === 'admin' && (await this.users.countAdmins()) <= 1) throw new ConflictException("You're the only admin. Make someone else an admin before deleting this account.");

    const id = new Types.ObjectId(userId);
    const [payments, sessions, pending] = await Promise.all([
      this.payments.updateMany({ userId: id }, { $set: { userId: null } }).exec(),
      this.refreshTokens.deleteMany({ userId: id }).exec(),
      this.pendingRegistrations.deleteMany({ email: user.email }).exec(),
    ]);
    // Last, so a failure part-way can simply be retried by the parent.
    await this.users.deleteById(userId);
    this.logger.log(`Account ${userId} deleted: ${sessions.deletedCount} sessions and ${pending.deletedCount} pending sign-ups removed, ${payments.modifiedCount} payment records unlinked`);

    this.mail.sendAccountDeleted(user.email, user.name).catch((error: unknown) => this.logger.warn(`Could not send the deletion email: ${describeError(error)}`));
  }
}
