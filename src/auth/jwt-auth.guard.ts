import { createParamDecorator, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ACCESS_COOKIE } from './auth-cookies.js';
import { TokensService, type AccessPayload } from './tokens.service.js';

type AuthedRequest = Request & { auth?: AccessPayload };

/** Allows the request only with a valid access token in its httpOnly cookie. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token: unknown = request.cookies?.[ACCESS_COOKIE];
    if (typeof token !== 'string' || !token) throw new UnauthorizedException('Please sign in.');
    try {
      request.auth = await this.tokens.verifyAccess(token);
    } catch {
      throw new UnauthorizedException('Your session has expired.');
    }
    return true;
  }
}

/** The verified access-token claims; use only on routes behind {@link JwtAuthGuard}. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AccessPayload => {
  const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new UnauthorizedException('Please sign in.');
  return auth;
});
