import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { UsersService } from '../users/users.service.js';
import { ACCESS_COOKIE } from './auth-cookies.js';
import { TokensService, type AccessPayload } from './tokens.service.js';

/** Signed in, and the account has the admin role. Read from the database on every request, so demoting takes effect at once. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly tokens: TokensService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { auth?: AccessPayload; adminEmail?: string }>();
    const token: unknown = request.cookies?.[ACCESS_COOKIE];
    if (typeof token !== 'string' || !token) throw new UnauthorizedException('Please sign in.');
    const auth = await this.tokens.verifyAccess(token).catch(() => {
      throw new UnauthorizedException('Your session has expired.');
    });
    const user = await this.users.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Please sign in.');
    if (!this.users.isAdmin(user)) throw new ForbiddenException('This account is not an admin.');
    request.auth = auth;
    request.adminEmail = user.email;
    return true;
  }
}
