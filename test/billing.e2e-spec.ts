import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { UsersService } from '../src/users/users.service.js';
import { getConnectionToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';

let mongo: MongoMemoryServer;
let app: INestApplication<App>;
let users: UsersService;
let fakeWebhookSecret: string;

const ADMIN = 'admin@example.com';
const DAY = 24 * 60 * 60 * 1000;
let counter = 0;
const newIp = () => `198.18.0.${++counter % 250}`;
const http = () => request(app.getHttpServer());
const validPlan = { name: 'Premium', amount: 24_900, durationDays: 30, premiumGameIds: ['animal-safari', 'color-quest'], missionsPremium: true, freeMissionDays: 3, active: true };

/** Creates a verified account and returns its session cookies. */
async function signedIn(email: string): Promise<string[]> {
  await users.createWithPassword(email, 'Parent', await argon2.hash('a long password'), { emailVerified: true });
  const res = await http().post('/api/auth/login').set('X-Forwarded-For', newIp()).send({ email, password: 'a long password' }).expect(200);
  return ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]);
}

/** Starts checkout, then presses a button on the fake gateway page and follows the browser back. Returns the app URL it lands on. */
async function pay(cookies: string[], outcome: 'paid' | 'failed'): Promise<string> {
  const checkout = await http().post('/api/billing/checkout').set('Cookie', cookies).send({}).expect(200);
  const ref = new URL(checkout.body.url as string).searchParams.get('ref')!;
  const back = await http().post('/api/billing/fake-checkout').type('form').send({ ref, outcome }).expect(303);
  const returnPath = new URL(back.headers.location as string);
  const landed = await http().get(returnPath.pathname + returnPath.search).expect(302);
  return landed.headers.location as string;
}

const me = async (cookies: string[]) => (await http().get('/api/auth/me').set('Cookie', cookies).expect(200)).body.user;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: mongo.getUri(),
    MONGO_DB_NAME: 'play-and-learn-billing-test',
    FRONTEND_URL: 'http://localhost:3000',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'r'.repeat(48),
    COOKIE_SECRET: 'c'.repeat(48),
    OTP_SECRET: 'o'.repeat(48),
    COOKIE_SECURE: 'false',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    SMTP_HOST: '',
    PAYMENT_PROVIDER: 'fake',
  });
  const [{ AppModule }, { configureApp }, { UsersService }, { FAKE_WEBHOOK_SECRET }] = await Promise.all([
    import('../src/app.module.js'),
    import('../src/configure-app.js'),
    import('../src/users/users.service.js'),
    import('../src/billing/providers/fake.provider.js'),
  ]);
  fakeWebhookSecret = FAKE_WEBHOOK_SECRET;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(nest);
  await nest.init();
  app = nest as unknown as INestApplication<App>;
  users = nest.get(UsersService);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await mongo?.stop();
});

describe('premium plan and admin', () => {
  it('starts with a default plan that is not on sale', async () => {
    const res = await http().get('/api/billing/plan').expect(200);
    expect(res.body).toEqual({ name: 'Play & Learn Premium', amount: 19_900, currency: 'INR', durationDays: 30, premiumGameIds: [], missionsPremium: false, freeMissionDays: 3, available: false, requiresPhone: false });
  });

  it('only lets accounts with the admin role into the admin API', async () => {
    await http().get('/api/admin/plan').expect(401);
    const parent = await signedIn('just-a-parent@example.com');
    await http().get('/api/admin/plan').set('Cookie', parent).expect(403);
    await http().put('/api/admin/plan').set('Cookie', parent).send(validPlan).expect(403);
    expect(await me(parent)).toMatchObject({ role: 'user', isAdmin: false });

    // Created the way `npm run admin -- create` does it.
    await users.createAdmin(ADMIN, 'Boss', await argon2.hash('a long password'));
    const admin = await adminCookies();
    expect(await me(admin)).toMatchObject({ role: 'admin', isAdmin: true, emailVerified: true });
    await expect(users.createAdmin(ADMIN, 'Again', 'hash')).rejects.toThrow(/already has an account/);

    // Promote and demote: checked on every request, so it applies to an existing session at once.
    expect((await users.setRole('just-a-parent@example.com', 'admin'))?.role).toBe('admin');
    await http().get('/api/admin/plan').set('Cookie', parent).expect(200);
    await users.setRole('just-a-parent@example.com', 'user');
    await http().get('/api/admin/plan').set('Cookie', parent).expect(403);
    expect(await users.setRole('nobody@example.com', 'admin')).toBeNull();
    expect((await users.listAdmins()).map((user) => user.email)).toEqual([ADMIN]);
    const res = await http().get('/api/admin/plan').set('Cookie', admin).expect(200);
    expect(res.body.provider).toBe('fake');
    expect(res.body.games.map((game: { id: string }) => game.id)).toEqual(['alphabet-adventure', 'animal-safari', 'color-quest', 'count-the-stars', 'shape-safari', 'memory-match', 'puzzle-playground']);
  });

  it('validates and saves the price, duration and premium games', async () => {
    const cookies = await adminCookies();
    const bad = await http().put('/api/admin/plan').set('Cookie', cookies).send({ ...validPlan, amount: 50, premiumGameIds: ['not-a-game'], durationDays: 0, freeMissionDays: 19 }).expect(400);
    expect(bad.body.message).toEqual(expect.arrayContaining(['The price must be at least ₹1.', 'Unknown game selected.', 'Premium must last at least 1 day.', 'There are only 18 missions.']));

    const saved = await http().put('/api/admin/plan').set('Cookie', cookies).send(validPlan).expect(200);
    expect(saved.body.plan).toMatchObject({ ...validPlan, currency: 'INR', updatedBy: ADMIN });
    const publicPlan = await http().get('/api/billing/plan').expect(200);
    expect(publicPlan.body).toMatchObject({ amount: 24_900, premiumGameIds: ['animal-safari', 'color-quest'], missionsPremium: true, freeMissionDays: 3, available: true });
  });
});

describe('paying for premium', () => {
  it('needs a signed-in parent', async () => {
    await http().post('/api/billing/checkout').send({}).expect(401);
  });

  it('grants premium after a successful payment, and extends it on the next one', async () => {
    const parent = await signedIn('payer@example.com');
    expect((await me(parent)).subscription.status).toBe('none');

    const checkout = await http().post('/api/billing/checkout').set('Cookie', parent).send({}).expect(200);
    const page = await http().get(new URL(checkout.body.url as string).pathname + new URL(checkout.body.url as string).search).expect(200);
    expect(page.text).toContain('₹249.00');
    expect(page.text).toContain('payer@example.com');

    expect(await pay(parent, 'paid')).toBe('http://localhost:3000/premium/success');
    const first = await me(parent);
    expect(first.subscription).toMatchObject({ status: 'active', plan: 'Premium' });
    const firstEnd = new Date(first.subscription.currentPeriodEnd).getTime();
    expect(Math.abs(firstEnd - (Date.now() + 30 * DAY))).toBeLessThan(60_000);

    await pay(parent, 'paid');
    const secondEnd = new Date((await me(parent)).subscription.currentPeriodEnd).getTime();
    expect(Math.abs(secondEnd - (firstEnd + 30 * DAY))).toBeLessThan(1000);
  });

  it('gives nothing for a declined payment', async () => {
    const parent = await signedIn('declined@example.com');
    expect(await pay(parent, 'failed')).toBe('http://localhost:3000/grown-ups?payment=failed');
    expect((await me(parent)).subscription.status).toBe('none');
  });

  it('shows "pending" when the parent comes back before paying, and ignores unknown references', async () => {
    const parent = await signedIn('pending@example.com');
    await http().post('/api/billing/checkout').set('Cookie', parent).send({}).expect(200);
    const admin = await adminCookies();
    const latest = (await http().get('/api/admin/payments').set('Cookie', admin).expect(200)).body.payments[0];
    const res = await http().get(`/api/billing/return?ref=${latest.id}`).expect(302);
    expect(res.headers.location).toBe('http://localhost:3000/grown-ups?payment=pending');
    expect((await http().get('/api/billing/return?ref=not-an-id').expect(302)).headers.location).toBe('http://localhost:3000/grown-ups?payment=failed');
  });

  it('settles a payment from a signed webhook exactly once', async () => {
    const parent = await signedIn('webhook@example.com');
    const checkout = await http().post('/api/billing/checkout').set('Cookie', parent).send({}).expect(200);
    const providerRef = new URL(checkout.body.url as string).searchParams.get('ref')!;
    const body = JSON.stringify({ providerRef, status: 'paid' });
    const signature = createHmac('sha256', fakeWebhookSecret).update(body).digest('hex');

    await http().post('/api/billing/webhook').set('Content-Type', 'application/json').set('x-fake-signature', 'forged').send(body).expect(400);
    expect((await me(parent)).subscription.status).toBe('none');

    await http().post('/api/billing/webhook').set('Content-Type', 'application/json').set('x-fake-signature', signature).send(body).expect(200, { received: true });
    const end = (await me(parent)).subscription.currentPeriodEnd;
    expect((await me(parent)).subscription.status).toBe('active');
    // Replayed webhook: no extra days.
    await http().post('/api/billing/webhook').set('Content-Type', 'application/json').set('x-fake-signature', signature).send(body).expect(200);
    expect((await me(parent)).subscription.currentPeriodEnd).toBe(end);
  });

  it('only lets the paying parent confirm a popup payment, and only with a popup gateway', async () => {
    const proof = { razorpayOrderId: 'order_ABC123', razorpayPaymentId: 'pay_ABC123', razorpaySignature: 'a'.repeat(64) };
    const parent = await signedIn('popup@example.com');
    await http().post('/api/billing/checkout').set('Cookie', parent).send({}).expect(200);
    const admin = await adminCookies();
    const latest = (await http().get('/api/admin/payments').set('Cookie', admin).expect(200)).body.payments[0];

    await http().post('/api/billing/checkout/confirm').send({ paymentId: latest.id, ...proof }).expect(401);
    await http().post('/api/billing/checkout/confirm').set('Cookie', parent).send({ paymentId: latest.id, razorpayOrderId: 'nope' }).expect(400);
    const stranger = await signedIn('stranger@example.com');
    await http().post('/api/billing/checkout/confirm').set('Cookie', stranger).send({ paymentId: latest.id, ...proof }).expect(404);
    // The fake gateway uses a hosted page, not a popup.
    await http().post('/api/billing/checkout/confirm').set('Cookie', parent).send({ paymentId: latest.id, ...proof }).expect(400);
    expect((await me(parent)).subscription.status).toBe('none');
  });

  it('stops new purchases when the plan is switched off', async () => {
    const admin = await adminCookies();
    await http().put('/api/admin/plan').set('Cookie', admin).send({ ...validPlan, active: false }).expect(200);
    const parent = await signedIn('too-late@example.com');
    const res = await http().post('/api/billing/checkout').set('Cookie', parent).send({}).expect(409);
    expect(res.body.message).toBe('Premium is not on sale right now.');
    expect((await http().get('/api/billing/plan').expect(200)).body.available).toBe(false);
    await http().put('/api/admin/plan').set('Cookie', admin).send(validPlan).expect(200);
  });

  it('shows admins the payments, revenue and active premium count', async () => {
    const admin = await adminCookies();
    const overview = (await http().get('/api/admin/payments').set('Cookie', admin).expect(200)).body;
    expect(overview.provider).toBe('fake');
    expect(overview.paidCount).toBe(3);
    expect(overview.revenue).toEqual([{ currency: 'INR', amount: 3 * 24_900 }]);
    expect(overview.activePremium).toBe(2);
    expect(overview.payments[0]).toMatchObject({ provider: 'fake', currency: 'INR' });
    expect(overview.payments.map((payment: { email: string }) => payment.email)).toContain('payer@example.com');
  });
});

describe('deleting an account', () => {
  const count = (collection: string, filter: object) => app.get<{ collection: (name: string) => { countDocuments: (query: object) => Promise<number> } }>(getConnectionToken()).collection(collection).countDocuments(filter);

  it('removes the parent and their sessions everywhere, and unlinks their payments', async () => {
    const parent = await signedIn('leaving@example.com');
    await pay(parent, 'paid');
    const { id } = await me(parent);
    const refresh = parent.find((cookie) => cookie.startsWith('pl_refresh='))!;
    const userId = new Types.ObjectId(id as string);
    expect(await count('payments', { userId })).toBe(1);
    expect(await count('refreshtokens', { userId })).toBeGreaterThan(0);

    await http().post('/api/account/delete').set('X-Forwarded-For', newIp()).send({ password: 'a long password' }).expect(401);
    await http().post('/api/account/delete').set('X-Forwarded-For', newIp()).set('Cookie', parent).send({}).expect(400);
    await http().post('/api/account/delete').set('X-Forwarded-For', newIp()).set('Cookie', parent).send({ password: 'wrong password' }).expect(403);
    expect(await users.findById(id as string)).not.toBeNull();

    const res = await http().post('/api/account/delete').set('X-Forwarded-For', newIp()).set('Cookie', parent).send({ password: 'a long password' }).expect(204);
    expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).some((line) => line.startsWith('pl_refresh=;'))).toBe(true);

    expect(await users.findById(id as string)).toBeNull();
    expect(await count('users', { email: 'leaving@example.com' })).toBe(0);
    expect(await count('refreshtokens', { userId })).toBe(0);
    expect(await count('payments', { userId })).toBe(0);
    expect(await count('payments', { userId: null, status: 'paid' })).toBeGreaterThan(0);
    // Old cookies and the password no longer work.
    await http().get('/api/auth/me').set('Cookie', parent).expect(401);
    await http().post('/api/auth/refresh').set('Cookie', refresh).expect(401);
    await http().post('/api/auth/login').set('X-Forwarded-For', newIp()).send({ email: 'leaving@example.com', password: 'a long password' }).expect(401);
    // Admins still see the sale, without a person attached.
    const admin = await adminCookies();
    const payments = (await http().get('/api/admin/payments').set('Cookie', admin).expect(200)).body.payments as { email: string | null; status: string }[];
    expect(payments.some((payment) => payment.email === null && payment.status === 'paid')).toBe(true);
    // The same email can start over.
    await signedIn('leaving@example.com');
  });

  it('asks Google-only parents to type their email instead of a password', async () => {
    const google = await users.upsertFromGoogle({ googleId: 'g-123', email: 'google-parent@example.com', name: 'Google Parent', avatarUrl: null });
    const { AuthService } = await import('../src/auth/auth.service.js');
    const session = await app.get(AuthService).signIn(google, { userAgent: null, ip: null });
    const cookies = [`pl_access=${session.accessToken}`];
    await http().post('/api/account/delete').set('X-Forwarded-For', newIp()).set('Cookie', cookies).send({ email: 'someone-else@example.com' }).expect(400);
    await http().post('/api/account/delete').set('X-Forwarded-For', newIp()).set('Cookie', cookies).send({ email: ' Google-Parent@example.com ' }).expect(204);
    expect(await count('users', { googleId: 'g-123' })).toBe(0);
  });

  it('never deletes the last admin', async () => {
    const admin = await adminCookies();
    const res = await http().post('/api/account/delete').set('X-Forwarded-For', newIp()).set('Cookie', admin).send({ password: 'a long password' }).expect(409);
    expect(res.body.message).toMatch(/only admin/);
    expect(await count('users', { email: ADMIN })).toBe(1);
  });
});

async function adminCookies(): Promise<string[]> {
  const res = await http().post('/api/auth/login').set('X-Forwarded-For', newIp()).send({ email: ADMIN, password: 'a long password' }).expect(200);
  return ([] as string[]).concat(res.headers['set-cookie']).map((line) => line.split(';')[0]);
}
