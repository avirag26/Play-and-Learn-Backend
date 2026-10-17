import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';

export type AccessPayload = { sub: string; email: string };
export type RefreshPayload = { sub: string; jti: string; fam: string };

const ISSUER = 'play-and-learn';
const ALGORITHM = 'HS256';

/** Signs and verifies the two JWTs. Access and refresh tokens use different secrets and audiences. */
@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get accessTtl(): number {
    return this.config.get('ACCESS_TOKEN_TTL', { infer: true });
  }

  get refreshTtl(): number {
    return this.config.get('REFRESH_TOKEN_TTL', { infer: true });
  }

  signAccess(payload: AccessPayload): Promise<string> {
    return this.jwt.signAsync(payload, { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), expiresIn: this.accessTtl, issuer: ISSUER, audience: 'access', algorithm: ALGORITHM });
  }

  async signRefresh(userId: string, family: string, jti: string = randomUUID()): Promise<{ token: string; jti: string }> {
    const payload: RefreshPayload = { sub: userId, jti, fam: family };
    const token = await this.jwt.signAsync(payload, { secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }), expiresIn: this.refreshTtl, issuer: ISSUER, audience: 'refresh', algorithm: ALGORITHM });
    return { token, jti };
  }

  /** Throws when the token is malformed, tampered with, expired, or of the wrong kind. */
  verifyAccess(token: string): Promise<AccessPayload> {
    return this.jwt.verifyAsync<AccessPayload>(token, { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), issuer: ISSUER, audience: 'access', algorithms: [ALGORITHM] });
  }

  verifyRefresh(token: string): Promise<RefreshPayload> {
    return this.jwt.verifyAsync<RefreshPayload>(token, { secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }), issuer: ISSUER, audience: 'refresh', algorithms: [ALGORITHM] });
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
