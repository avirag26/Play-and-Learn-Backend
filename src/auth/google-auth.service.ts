import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import type { Env } from '../config/env.js';
import type { GoogleProfile } from '../users/users.service.js';

/** Google sign-in with the authorization-code flow, protected by `state` and PKCE. */
@Injectable()
export class GoogleAuthService {
  private readonly client: OAuth2Client | null;
  private readonly clientId: string | undefined;

  constructor(config: ConfigService<Env, true>) {
    this.clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
    const clientSecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
    const redirectUri = config.get('GOOGLE_CALLBACK_URL', { infer: true });
    this.client = this.clientId && clientSecret && redirectUri ? new OAuth2Client({ clientId: this.clientId, clientSecret, redirectUri }) : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async createAuthorization(): Promise<{ url: string; state: string; codeVerifier: string }> {
    const client = this.requireClient();
    const state = randomBytes(32).toString('base64url');
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: 'select_account',
      access_type: 'online',
    });
    return { url, state, codeVerifier };
  }

  /** Exchanges the callback code and returns the verified Google profile. */
  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleProfile> {
    const client = this.requireClient();
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) throw new UnauthorizedException('Google did not return an identity.');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) throw new UnauthorizedException('Google did not confirm this email address.');
    return { googleId: payload.sub, email: payload.email.toLowerCase(), name: payload.name?.trim() || payload.email.split('@')[0], avatarUrl: payload.picture ?? null };
  }

  private requireClient(): OAuth2Client {
    if (!this.client) throw new UnauthorizedException('Google sign-in is not configured.');
    return this.client;
  }
}
