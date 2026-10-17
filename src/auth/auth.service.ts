import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { UserDocument } from '../users/user.schema.js';
import { UsersService, type GoogleProfile, type PublicUser } from '../users/users.service.js';
import type { LoginDto } from './dto/auth.dto.js';
import { RefreshToken } from './refresh-token.schema.js';
import { TokensService } from './tokens.service.js';

export type SessionMeta = { userAgent: string | null; ip: string | null };
export type Session = { user: PublicUser; accessToken: string; refreshToken: string };

/**
 * When two tabs refresh with the same token at once, the second arrives just after the first rotated
 * it. Within this window that is treated as a race, not theft, and the second tab gets its own token.
 */
const REUSE_GRACE_MS = 10_000;
const INVALID_LOGIN = 'Email or password is incorrect.';
const SESSION_ENDED = 'Your session has ended. Please sign in again.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Verified against when the account does not exist, so response time does not reveal which emails are registered. */
  private readonly dummyHash = argon2.hash(randomUUID(), { type: argon2.argon2id });

  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    @InjectModel(RefreshToken.name) private readonly refreshTokens: Model<RefreshToken>,
  ) {}

  /** Signs in a just-created account (after its email code was confirmed). */
  async signIn(user: UserDocument, meta: SessionMeta): Promise<Session> {
    return this.startSession(user, randomUUID(), meta);
  }

  async login(dto: LoginDto, meta: SessionMeta): Promise<Session> {
    const user = await this.users.findByEmailWithPassword(dto.email);
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const matches = await argon2.verify(hash, dto.password).catch(() => false);
    if (!user?.passwordHash || !matches) throw new UnauthorizedException(INVALID_LOGIN);
    return this.startSession(user, randomUUID(), meta);
  }

  async loginWithGoogle(profile: GoogleProfile, meta: SessionMeta): Promise<Session> {
    const user = await this.users.upsertFromGoogle(profile);
    return this.startSession(user, randomUUID(), meta);
  }

  /** Swaps a refresh token for a new access + refresh pair. Each refresh token works once. */
  async refresh(refreshToken: string, meta: SessionMeta): Promise<Session> {
    const payload = await this.tokens.verifyRefresh(refreshToken).catch(() => {
      throw new UnauthorizedException(SESSION_ENDED);
    });
    const tokenHash = this.tokens.hash(refreshToken);
    const user = await this.users.findById(payload.sub);
    if (!user) {
      await this.revokeFamily(payload.fam);
      throw new UnauthorizedException(SESSION_ENDED);
    }

    const nextJti = randomUUID();
    const claimed = await this.refreshTokens
      .findOneAndUpdate({ jti: payload.jti, tokenHash, revokedAt: null }, { $set: { revokedAt: new Date(), replacedBy: nextJti } })
      .exec();
    if (claimed) return this.startSession(user, payload.fam, meta, nextJti);

    const stored = await this.refreshTokens.findOne({ jti: payload.jti, tokenHash }).exec();
    const rotatedJustNow = stored?.replacedBy && stored.revokedAt && Date.now() - stored.revokedAt.getTime() <= REUSE_GRACE_MS;
    // ...and only while the session is still live (no sign-out since).
    if (stored && rotatedJustNow && (await this.refreshTokens.exists({ jti: stored.replacedBy, revokedAt: null }))) return this.startSession(user, payload.fam, meta);

    // A token that was already used (or revoked by sign-out) came back: assume it was stolen.
    if (stored) {
      this.logger.warn(`Refresh token reuse detected for user ${payload.sub}; revoking the session.`);
      await this.revokeFamily(payload.fam);
    }
    throw new UnauthorizedException(SESSION_ENDED);
  }

  /** Ends the session this refresh token belongs to. Invalid tokens are ignored. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const payload = await this.tokens.verifyRefresh(refreshToken).catch(() => null);
    if (payload) await this.revokeFamily(payload.fam);
  }

  private async startSession(user: UserDocument, family: string, meta: SessionMeta, jti?: string): Promise<Session> {
    const userId = user.id as string;
    const [accessToken, refresh] = await Promise.all([this.tokens.signAccess({ sub: userId, email: user.email }), this.tokens.signRefresh(userId, family, jti)]);
    await this.refreshTokens.create({
      jti: refresh.jti,
      userId: new Types.ObjectId(userId),
      family,
      tokenHash: this.tokens.hash(refresh.token),
      expiresAt: new Date(Date.now() + this.tokens.refreshTtl * 1000),
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return { user: this.users.toPublic(user), accessToken, refreshToken: refresh.token };
  }

  private async revokeFamily(family: string): Promise<void> {
    await this.refreshTokens.updateMany({ family, revokedAt: null }, { $set: { revokedAt: new Date() } }).exec();
  }
}
