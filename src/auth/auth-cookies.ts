import type { CookieOptions, Response } from 'express';

export const ACCESS_COOKIE = 'pl_access';
export const REFRESH_COOKIE = 'pl_refresh';
export const GOOGLE_STATE_COOKIE = 'pl_google_state';

/** The refresh token is only ever sent to the auth routes that need it. */
export const REFRESH_COOKIE_PATH = '/api/auth';
export const GOOGLE_STATE_COOKIE_PATH = '/api/auth/google';

export type CookieSettings = { secure: boolean };

const base = ({ secure }: CookieSettings): CookieOptions => ({ httpOnly: true, secure, sameSite: 'lax' });

export function setSessionCookies(res: Response, settings: CookieSettings, tokens: { accessToken: string; refreshToken: string; accessTtl: number; refreshTtl: number }): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base(settings), path: '/', maxAge: tokens.accessTtl * 1000 });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...base(settings), path: REFRESH_COOKIE_PATH, maxAge: tokens.refreshTtl * 1000 });
}

export function clearSessionCookies(res: Response, settings: CookieSettings): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(settings), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(settings), path: REFRESH_COOKIE_PATH });
}

export function setGoogleStateCookie(res: Response, settings: CookieSettings, value: string): void {
  res.cookie(GOOGLE_STATE_COOKIE, value, { ...base(settings), path: GOOGLE_STATE_COOKIE_PATH, maxAge: 10 * 60 * 1000, signed: true });
}

export function clearGoogleStateCookie(res: Response, settings: CookieSettings): void {
  res.clearCookie(GOOGLE_STATE_COOKIE, { ...base(settings), path: GOOGLE_STATE_COOKIE_PATH, signed: true });
}
