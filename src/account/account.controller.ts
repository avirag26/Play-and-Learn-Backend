import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { clearSessionCookies } from '../auth/auth-cookies.js';
import { CurrentAuth, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AccessPayload } from '../auth/tokens.service.js';
import type { Env } from '../config/env.js';
import { DeleteAccountDto } from './account.dto.js';
import { AccountService } from './account.service.js';

@Controller('account')
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Permanently deletes the signed-in parent's account, then signs this browser out. */
  @Post('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async delete(@CurrentAuth() auth: AccessPayload, @Body() dto: DeleteAccountDto, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.account.deleteAccount(auth.sub, dto);
    clearSessionCookies(res, { secure: this.config.get('COOKIE_SECURE', { infer: true }) === 'true' });
  }
}
