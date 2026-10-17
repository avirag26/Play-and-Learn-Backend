import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Post, Query, Req, Res, UnauthorizedException, UseGuards, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env.js';
import { UsersService, type PublicUser } from '../users/users.service.js';
import { clearGoogleStateCookie, clearSessionCookies, GOOGLE_STATE_COOKIE, REFRESH_COOKIE, setGoogleStateCookie, setSessionCookies, type CookieSettings } from './auth-cookies.js';
import { AuthService, type Session, type SessionMeta } from './auth.service.js';
import { LoginDto, RegisterDto, ResendCodeDto, VerifyCodeDto } from './dto/auth.dto.js';
import { GoogleAuthService } from './google-auth.service.js';
import { CurrentAuth, JwtAuthGuard } from './jwt-auth.guard.js';
import { RegistrationService, type CodeSent } from './registration.service.js';
import { TokensService, type AccessPayload } from './tokens.service.js';

const DEFAULT_RETURN_TO = '/grown-ups';
type GoogleState = { state: string; codeVerifier: string; returnTo: string };

/** Only same-site paths, so the sign-in redirect cannot be pointed at another website. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && value.length <= 200 ? value : DEFAULT_RETURN_TO;
}

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleAuthService,
    private readonly registration: RegistrationService,
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Which sign-in buttons the web app should show. */
  @Get('providers')
  providers(): { password: boolean; google: boolean } {
    return { password: true, google: this.google.enabled };
  }

  /** Sign-up step 1: emails a 6-digit code. The account does not exist until the code is confirmed. */
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() dto: RegisterDto): Promise<CodeSent> {
    return this.registration.start(dto);
  }

  @Post('register/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  resendCode(@Body() dto: ResendCodeDto): Promise<CodeSent> {
    return this.registration.resend(dto.email);
  }

  /** Sign-up step 2: confirms the code, creates the account and signs it in. */
  @Post('register/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verifyCode(@Body() dto: VerifyCodeDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: PublicUser }> {
    const user = await this.registration.verify(dto.email, dto.code);
    return this.sendSession(res, await this.auth.signIn(user, this.meta(req)));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: PublicUser }> {
    return this.sendSession(res, await this.auth.login(dto, this.meta(req)));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: PublicUser }> {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string' || !token) throw new UnauthorizedException('Please sign in.');
    try {
      return this.sendSession(res, await this.auth.refresh(token, this.meta(req)));
    } catch (error) {
      clearSessionCookies(res, this.cookieSettings);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    await this.auth.logout(typeof token === 'string' ? token : undefined);
    clearSessionCookies(res, this.cookieSettings);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentAuth() auth: AccessPayload): Promise<{ user: PublicUser }> {
    const user = await this.users.findById(auth.sub);
    if (!user) throw new UnauthorizedException('Please sign in.');
    return { user: this.users.toPublic(user) };
  }

  /** Starts Google sign-in: remembers state + PKCE verifier in a signed cookie, then sends the browser to Google. */
  @Get('google')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async startGoogle(@Query('returnTo') returnTo: unknown, @Res() res: Response): Promise<void> {
    const destination = safeReturnTo(returnTo);
    if (!this.google.enabled) return res.redirect(this.frontendUrl(destination, { auth_error: 'google_unavailable' }));
    const { url, state, codeVerifier } = await this.google.createAuthorization();
    const stored: GoogleState = { state, codeVerifier, returnTo: destination };
    setGoogleStateCookie(res, this.cookieSettings, JSON.stringify(stored));
    res.redirect(url);
  }

  @Get('google/callback')
  async googleCallback(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const stored = this.readGoogleState(req);
    clearGoogleStateCookie(res, this.cookieSettings);
    const returnTo = stored?.returnTo ?? DEFAULT_RETURN_TO;
    const fail = (reason: string) => res.redirect(this.frontendUrl(returnTo, { auth_error: reason }));

    if (typeof query.error === 'string') return fail('google_cancelled');
    if (!stored || typeof query.state !== 'string' || !sameText(query.state, stored.state) || typeof query.code !== 'string') return fail('google_state');
    try {
      const profile = await this.google.exchangeCode(query.code, stored.codeVerifier);
      this.sendSession(res, await this.auth.loginWithGoogle(profile, this.meta(req)));
      res.redirect(this.frontendUrl(returnTo, { auth: 'google' }));
    } catch (error) {
      if (!(error instanceof ConflictException)) this.logger.error('Google sign-in failed', error instanceof Error ? error.stack : String(error));
      fail(error instanceof ConflictException ? 'google_conflict' : 'google_failed');
    }
  }

  private get cookieSettings(): CookieSettings {
    return { secure: this.config.get('COOKIE_SECURE', { infer: true }) === 'true' };
  }

  private sendSession(res: Response, session: Session): { user: PublicUser } {
    setSessionCookies(res, this.cookieSettings, { accessToken: session.accessToken, refreshToken: session.refreshToken, accessTtl: this.tokens.accessTtl, refreshTtl: this.tokens.refreshTtl });
    return { user: session.user };
  }

  private meta(req: Request): SessionMeta {
    return { userAgent: req.get('user-agent')?.slice(0, 300) ?? null, ip: req.ip ?? null };
  }

  private readGoogleState(req: Request): GoogleState | null {
    const raw: unknown = req.signedCookies?.[GOOGLE_STATE_COOKIE];
    if (typeof raw !== 'string') return null;
    try {
      const value = JSON.parse(raw) as Partial<GoogleState>;
      return typeof value.state === 'string' && typeof value.codeVerifier === 'string' ? { state: value.state, codeVerifier: value.codeVerifier, returnTo: safeReturnTo(value.returnTo) } : null;
    } catch {
      return null;
    }
  }

  private frontendUrl(path: string, params: Record<string, string>): string {
    const url = new URL(path, this.config.get('FRONTEND_URL', { infer: true }));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }
}
