import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { PendingRegistration } from '../src/auth/pending-registration.schema.js';
import type { RefreshToken } from '../src/auth/refresh-token.schema.js';
import type { UsersService } from '../src/users/users.service.js';

let mongo: MongoMemoryServer;
let app: INestApplication<App>;
let refreshTokens: Model<RefreshToken>;
let pending: Model<PendingRegistration>;
let users: UsersService;

type SentMail = { to: string; kind: 'code' | 'already-registered'; code?: string };

/** Stands in for SMTP: records what would have been emailed. */
class FakeMail {
  sent: SentMail[] = [];
  failNext = false;
  private check() {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SMTP is down');
    }
  }
  sendSignUpCode(to: string, _name: string, code: string): Promise<void> {
    this.check();
    this.sent.push({ to, kind: 'code', code });
    return Promise.resolve();
  }
  sendAlreadyRegistered(to: string): Promise<void> {
    this.check();
    this.sent.push({ to, kind: 'already-registered' });
    return Promise.resolve();
  }
  last(to: string): SentMail | undefined {
    return this.sent.filter((mail) => mail.to === to).at(-1);
  }
}
const mail = new FakeMail();

/** Reads one cookie from a response's Set-Cookie headers. */
function cookie(res: request.Response, name: string): { value: string; attributes: string } | null {
  const headers = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const line = headers.find((header) => header.startsWith(`${name}=`));
  if (!line) return null;
  const [pair, ...attributes] = line.split(';');
  return { value: decodeURIComponent(pair.slice(name.length + 1)), attributes: attributes.join(';') };
}

const sessionCookies = (res: request.Response) => [`pl_access=${cookie(res, 'pl_access')!.value}`, `pl_refresh=${cookie(res, 'pl_refresh')!.value}`];
const refreshCookie = (res: request.Response) => `pl_refresh=${cookie(res, 'pl_refresh')!.value}`;
let counter = 0;
const newEmail = () => `parent${++counter}@example.com`;
// Each request group comes from its own client IP (as forwarded by the web app's proxy), so per-IP limits are not hit.
const newIp = () => `203.0.113.${++counter % 250}`;
const post = (path: string, ip = newIp()) => request(app.getHttpServer()).post(`/api/auth/${path}`).set('X-Forwarded-For', ip);
const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

function startSignUp(email: string, password = 'correct horse battery', name = 'Sam Parent') {
  return post('register').send({ email, password, name });
}

/** Full sign-up: details, then the emailed code. Returns the signed-in response. */
async function register(email = newEmail(), password = 'correct horse battery') {
  await startSignUp(email, password).expect(202);
  const normalised = email.trim().toLowerCase();
  const res = await post('register/verify').send({ email: normalised, code: mail.last(normalised)!.code });
  expect(res.status).toBe(201);
  return res;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: mongo.getUri(),
    MONGO_DB_NAME: 'play-and-learn-test',
    FRONTEND_URL: 'http://localhost:3000',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'r'.repeat(48),
    COOKIE_SECRET: 'c'.repeat(48),
    OTP_SECRET: 'o'.repeat(48),
    COOKIE_SECURE: 'false',
    // Override anything in the developer's .env (environment variables win over the file).
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    SMTP_HOST: '',
  });
  // Imported after the environment is set, because ConfigModule validates it on import.
  const [{ AppModule }, { configureApp }, { RefreshToken }, { PendingRegistration }, { UsersService }, { MailService }] = await Promise.all([
    import('../src/app.module.js'),
    import('../src/configure-app.js'),
    import('../src/auth/refresh-token.schema.js'),
    import('../src/auth/pending-registration.schema.js'),
    import('../src/users/users.service.js'),
    import('../src/mail/mail.service.js'),
  ]);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailService).useValue(mail).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(nest);
  await nest.init();
  app = nest as unknown as INestApplication<App>;
  refreshTokens = nest.get(getModelToken(RefreshToken.name));
  pending = nest.get(getModelToken(PendingRegistration.name));
  users = nest.get(UsersService);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await mongo?.stop();
});

describe('sign-up with an emailed code', () => {
  it('reports health and which sign-in methods exist', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get('/api/auth/providers').expect(200, { password: true, google: false });
  });

  it('emails a code first and only creates the account once the code is confirmed', async () => {
    const started = await startSignUp('New.Parent@Example.com ').expect(202);
    expect(started.body).toEqual({ email: 'new.parent@example.com', expiresIn: 600, resendIn: 60 });
    expect(cookie(started, 'pl_access')).toBeNull();
    const sent = mail.last('new.parent@example.com')!;
    expect(sent.kind).toBe('code');
    expect(sent.code).toMatch(/^\d{6}$/);
    expect(await users.existsByEmail('new.parent@example.com')).toBe(false);
    await post('login').send({ email: 'new.parent@example.com', password: 'correct horse battery' }).expect(401);

    const wrong = await post('register/verify').send({ email: 'new.parent@example.com', code: wrongCode(sent.code!) }).expect(400);
    expect(wrong.body.message).toBe("That code isn't right. 4 tries left.");

    const res = await post('register/verify').send({ email: 'new.parent@example.com', code: ` ${sent.code!.slice(0, 3)} ${sent.code!.slice(3)} ` }).expect(201);
    expect(res.body.user).toMatchObject({ email: 'new.parent@example.com', name: 'Sam Parent', emailVerified: true, providers: ['password'], subscription: { status: 'none', plan: null } });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2|codeHash/);
    const access = cookie(res, 'pl_access')!;
    const refresh = cookie(res, 'pl_refresh')!;
    expect(access.attributes).toMatch(/HttpOnly/);
    expect(access.attributes).toMatch(/SameSite=Lax/);
    expect(access.attributes).toMatch(/Path=\/(;|$)/);
    expect(refresh.attributes).toMatch(/HttpOnly/);
    expect(refresh.attributes).toMatch(/Path=\/api\/auth/);

    const me = await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', sessionCookies(res)).expect(200);
    expect(me.body.user.email).toBe('new.parent@example.com');
    // A code works once.
    await post('register/verify').send({ email: 'new.parent@example.com', code: sent.code }).expect(400);
    await post('login').send({ email: 'new.parent@example.com', password: 'correct horse battery' }).expect(200);
  });

  it('answers the same for an email that already has an account, and emails that person instead', async () => {
    const email = newEmail();
    await register(email);
    const again = await startSignUp(email.toUpperCase(), 'another password', 'Twin').expect(202);
    expect(again.body).toEqual({ email, expiresIn: 600, resendIn: 60 });
    expect(mail.last(email)).toEqual({ to: email, kind: 'already-registered' });
    await post('register/verify').send({ email, code: '123456' }).expect(400);
  });

  it('rejects invalid input', async () => {
    const invalid = await post('register').send({ email: 'not-an-email', password: 'short', name: '' }).expect(400);
    expect(invalid.body.message).toEqual(expect.arrayContaining(['Enter a valid email address.', 'Use at least 8 characters for the password.']));
    await post('register').send({ email: newEmail(), password: 'long enough pw', name: 'X', role: 'admin' }).expect(400);
    const badCode = await post('register/verify').send({ email: newEmail(), code: '12ab' }).expect(400);
    expect(badCode.body.message).toEqual(['Enter the 6-digit code from the email.']);
  });

  it('locks a code after 5 wrong guesses, even the right one', async () => {
    const email = newEmail();
    await startSignUp(email).expect(202);
    const code = mail.last(email)!.code!;
    for (let i = 0; i < 4; i++) await post('register/verify').send({ email, code: wrongCode(code) }).expect(400);
    const last = await post('register/verify').send({ email, code: wrongCode(code) }).expect(400);
    expect(last.body.message).toBe('Too many wrong codes. Request a new one.');
    await post('register/verify').send({ email, code }).expect(400);
    expect(await users.existsByEmail(email)).toBe(false);
  });

  it('rejects an expired code', async () => {
    const email = newEmail();
    await startSignUp(email).expect(202);
    await pending.updateOne({ email }, { $set: { codeExpiresAt: new Date(Date.now() - 1000) } });
    const res = await post('register/verify').send({ email, code: mail.last(email)!.code }).expect(400);
    expect(res.body.message).toBe('This code has expired. Request a new one.');
  });

  it('resends a fresh code after the cooldown, and the old code stops working', async () => {
    const email = newEmail();
    await startSignUp(email).expect(202);
    const first = mail.last(email)!.code!;
    const tooSoon = await post('register/resend').send({ email }).expect(429);
    expect(tooSoon.body.message).toMatch(/Please wait \d+ seconds/);
    await startSignUp(email).expect(429);

    await pending.updateOne({ email }, { $set: { lastSentAt: new Date(Date.now() - 61_000) } });
    await post('register/resend').send({ email }).expect(202, { email, expiresIn: 600, resendIn: 60 });
    const second = mail.last(email)!.code!;
    if (second !== first) await post('register/verify').send({ email, code: first }).expect(400);
    await post('register/verify').send({ email, code: second }).expect(201);

    const unknown = newEmail();
    await post('register/resend').send({ email: unknown }).expect(202);
    expect(mail.last(unknown)).toBeUndefined();
  });

  it('lets the parent retry straight away when the email could not be sent', async () => {
    const email = newEmail();
    mail.failNext = true;
    const failed = await startSignUp(email).expect(503);
    expect(failed.body.message).toBe("We couldn't send the email. Please try again in a moment.");
    await startSignUp(email).expect(202);
    expect(mail.last(email)!.kind).toBe('code');
  });

  it('rate-limits sign-up requests per client IP', async () => {
    const attempt = () => post('register', '198.51.100.7').send({ email: newEmail(), password: 'long enough pw', name: 'Bot' });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(202);
    expect((await attempt()).status).toBe(429);
  });
});

describe('sessions', () => {
  it('logs in with the right password and gives one message for every failure', async () => {
    const email = newEmail();
    await register(email, 'right password!');
    const wrong = await post('login').send({ email, password: 'wrong password' }).expect(401);
    const unknown = await post('login').send({ email: 'nobody@example.com', password: 'whatever pw' }).expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
    expect(cookie(wrong, 'pl_access')).toBeNull();

    const ok = await post('login').send({ email, password: 'right password!' }).expect(200);
    await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', sessionCookies(ok)).expect(200);
  });

  it('protects /me', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', 'pl_access=not.a.jwt').expect(401);
    // A refresh token is not accepted as an access token.
    const res = await register();
    await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', `pl_access=${cookie(res, 'pl_refresh')!.value}`).expect(401);
  });

  it('rotates refresh tokens and revokes the session when an old one is reused', async () => {
    const first = await register();
    const second = await post('refresh').set('Cookie', refreshCookie(first)).expect(200);
    expect(cookie(second, 'pl_refresh')!.value).not.toBe(cookie(first, 'pl_refresh')!.value);
    await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', sessionCookies(second)).expect(200);

    // Pretend the rotation happened long ago, so replaying the first token is theft, not a tab race.
    await refreshTokens.updateMany({ replacedBy: { $ne: null } }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
    const replay = await post('refresh').set('Cookie', refreshCookie(first)).expect(401);
    expect(cookie(replay, 'pl_refresh')?.value).toBe('');
    // The legitimate holder's newer token is revoked too.
    await post('refresh').set('Cookie', refreshCookie(second)).expect(401);
  });

  it('lets two tabs refresh with the same token at the same moment', async () => {
    const session = await register();
    const [a, b] = await Promise.all([1, 2].map(() => post('refresh').set('Cookie', refreshCookie(session))));
    expect([a.status, b.status]).toEqual([200, 200]);
    await post('refresh').set('Cookie', refreshCookie(a)).expect(200);
    await post('refresh').set('Cookie', refreshCookie(b)).expect(200);
  });

  it('logs out: clears cookies and the refresh token stops working', async () => {
    const session = await register();
    const out = await post('logout').set('Cookie', sessionCookies(session)).expect(204);
    expect(cookie(out, 'pl_access')?.value).toBe('');
    expect(cookie(out, 'pl_refresh')?.value).toBe('');
    await post('refresh').set('Cookie', refreshCookie(session)).expect(401);
    await post('logout').expect(204);
  });
});

describe('Google', () => {
  it('sends the browser back to the app when Google sign-in is not configured', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/google').query({ returnTo: 'https://evil.example/' }).expect(302);
    expect(res.headers.location).toBe('http://localhost:3000/grown-ups?auth_error=google_unavailable');
    const callback = await request(app.getHttpServer()).get('/api/auth/google/callback').query({ code: 'x', state: 'y' }).expect(302);
    expect(callback.headers.location).toBe('http://localhost:3000/grown-ups?auth_error=google_state');
  });

  it('links Google to a verified email account and keeps its password', async () => {
    const email = newEmail();
    await register(email, 'my own password');
    const linked = await users.upsertFromGoogle({ googleId: 'google-verified', email, name: 'Same Person', avatarUrl: null });
    expect(users.toPublic(linked)).toMatchObject({ email, providers: ['password', 'google'] });
    await post('login').send({ email, password: 'my own password' }).expect(200);
  });

  it('drops the password of an older, never-verified account when Google proves who owns the email', async () => {
    const email = newEmail();
    await users.createWithPassword(email, 'Squatter', await argon2.hash('squatter password'), { emailVerified: false });
    const linked = await users.upsertFromGoogle({ googleId: 'google-123', email, name: 'Real Owner', avatarUrl: null });
    expect(users.toPublic(linked)).toMatchObject({ email, emailVerified: true, providers: ['google'] });
    await post('login').send({ email, password: 'squatter password' }).expect(401);
    const again = await users.upsertFromGoogle({ googleId: 'google-123', email, name: 'Real Owner', avatarUrl: null });
    expect(again.id).toBe(linked.id);
    await expect(users.upsertFromGoogle({ googleId: 'google-other', email, name: 'Someone', avatarUrl: null })).rejects.toThrow(/another Google account/);

    const fresh = await users.upsertFromGoogle({ googleId: 'google-456', email: newEmail(), name: 'Google Only', avatarUrl: 'https://example.com/a.png' });
    expect(users.toPublic(fresh)).toMatchObject({ providers: ['google'], emailVerified: true, avatarUrl: 'https://example.com/a.png' });
  });
});
