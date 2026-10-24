# Play & Learn API

NestJS + TypeScript + MongoDB (Mongoose). Handles parent accounts for the Play & Learn web app, as the base for paid subscriptions.

## Run it

```bash
npm install
cp .env.example .env   # then fill in MONGO_URI, the four secrets and (for real emails) SMTP
npm run start:dev      # http://localhost:4000/api
```

The web app (`../play-and-learn`) proxies `/api/*` to this server, so in the browser everything is same-origin and the auth cookies are first-party. Run both, then open http://localhost:3000/grown-ups → **Account**.

| Script | What it does |
| --- | --- |
| `npm run start:dev` | Development server with reload |
| `npm run build` / `npm run start:prod` | Compile to `dist/` and run it |
| `npm test` | Unit tests |
| `npm run test:e2e` | End-to-end tests against an in-memory MongoDB (downloads a MongoDB binary the first time) |
| `npm run lint` | oxlint |

## Endpoints

All under `/api`.

| Method | Path | |
| --- | --- | --- |
| GET | `/health` | Liveness check |
| GET | `/auth/providers` | `{ password: true, google: boolean }`; Google is `false` until it is configured |
| POST | `/auth/register` | Sign-up step 1: `{ email, password, name }` → `202 { email, expiresIn, resendIn }`; emails a 6-digit code |
| POST | `/auth/register/resend` | `{ email }` → `202`, a new code (after 60 s) |
| POST | `/auth/register/verify` | Sign-up step 2: `{ email, code }` → `201 { user }` + session cookies; the account is created now |
| POST | `/auth/login` | `{ email, password }` → `200 { user }` + session cookies |
| POST | `/auth/refresh` | Uses the refresh cookie → `200 { user }` + new session cookies |
| POST | `/auth/logout` | Ends the session → `204`, cookies cleared |
| GET | `/auth/me` | Needs the access cookie → `{ user }` (includes `isAdmin` and `subscription`) |
| GET | `/auth/google?returnTo=/grown-ups` | Redirects to Google |
| GET | `/auth/google/callback` | Google redirects here; sets session cookies and redirects to the web app with `?auth=google` or `?auth_error=…` |

`user` is `{ id, email, name, avatarUrl, emailVerified, providers, subscription: { status, plan, currentPeriodEnd }, createdAt }`. `subscription.status` is `none` until payments are added.

## How sign-in works

- **Two JWTs, both in `httpOnly`, `SameSite=Lax` cookies** (`Secure` unless `COOKIE_SECURE=false`). JavaScript never sees them.
  - `pl_access`: 15 minutes, path `/`, signed with `JWT_ACCESS_SECRET`.
  - `pl_refresh`: 30 days, path `/api/auth` only, signed with `JWT_REFRESH_SECRET`. Tokens carry an `aud` claim, so one kind cannot be used as the other.
- **Refresh rotation with reuse detection.** Every refresh token works once and is stored (as a SHA-256 hash) in `refreshtokens`; using it issues a new pair in the same "family". If an already-used token comes back later, it was copied, so the whole family is revoked and that device must sign in again. A 10-second grace window covers two tabs refreshing at the same moment. Expired tokens are deleted by a MongoDB TTL index.
- **Sign-up needs an emailed code.** Step 1 stores the details in `pendingregistrations` (password already hashed) and emails a 6-digit code; the account only exists after step 2 confirms it, so every password account has a verified email. Codes last 10 minutes, allow 5 wrong guesses, can be resent every 60 seconds (5 emails per sign-up), work once, and are stored as an HMAC keyed by `OTP_SECRET`. If the email already has an account, that person gets a "you already have an account" email instead and the API answers exactly the same, so sign-up can't be used to find out who is registered. Pending sign-ups expire after an hour.
- **Email** goes through any SMTP server (`SMTP_*`). In development without `SMTP_HOST`, emails, including the code, are printed in the API's terminal; production refuses to start without SMTP.
- **Passwords** are hashed with Argon2id. Login failures give one message whether the email exists or not, and take the same time.
- **Google** uses the authorization-code flow with `state` and PKCE, kept in a signed, short-lived cookie. Only Google-verified emails are accepted. Signing in with Google links to an existing account with the same email; if that account never proved it owns the email, its password is removed so whoever registered it cannot keep access.
- **Rate limits** per client IP: 5 sign-up and 5 resend requests, 10 code checks, 10 logins, 30 refreshes per minute (120 for everything else). Behind a proxy, `TRUST_PROXY` decides whose `X-Forwarded-For` is believed.
- `helmet` security headers, strict input validation (unknown fields are rejected), and environment validation at startup.

## Premium and payments

One Premium plan, edited in the admin app (`../play-and-learn-admin`): name, price, how many days one payment unlocks, which games are premium, and whether it's on sale. A payment adds that many days (on top of any time left). There is no automatic renewal.

| Method | Path | |
| --- | --- | --- |
| GET | `/billing/plan` | Public: price, duration, `premiumGameIds`, `available` |
| POST | `/billing/checkout` | Signed in: `{ phone? }` → `{ url }` of the gateway's hosted payment page, `{ form }` to post to it (PayU), or `{ paymentId, popup }` |
| GET / POST | `/billing/return?ref=` | The gateway sends the browser here (PayU with a POST); we ask the gateway for the result and redirect to `/grown-ups?payment=success|pending|failed` |
| POST | `/billing/webhook` | Gateway notifications (signature-checked against the raw body) |
| GET / PUT | `/admin/plan` | Admin: read / save the plan |
| GET | `/admin/payments` | Admin: active Premium count, revenue, last 50 payments |

**Switching gateway is one line in `.env`:** `PAYMENT_PROVIDER=payu | razorpay | cashfree | stripe` plus that gateway's keys. Each gateway is one file in `src/billing/providers/` implementing the `PaymentProvider` interface (`payment-provider.ts`); `payment-provider.factory.ts` picks one. All three use a hosted payment page (Razorpay Payment Links, Cashfree Payment Links, Stripe Checkout), so nothing else changes. Cashfree also needs the parent's mobile number; the app asks for it only then.

`PAYMENT_PROVIDER=fake` is a local test gateway with Pay / Fail buttons and no real money; the API refuses it in production.

A payment is confirmed twice: when the browser returns (the API asks the gateway), and by the gateway's webhook (in case the browser never comes back). Premium is granted exactly once per payment. Register the webhook URL `https://<your-domain>/api/billing/webhook` in the gateway dashboard:

- **PayU**: Hosted Checkout (the app posts a form signed with the salt to PayU, which needs the parent's mobile number). Keys `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT` (Salt v1); `PAYU_ENV=production` for the live account, `test` with test keys. Webhooks: Successful and Failed payment events, verified with PayU's reverse hash. `FRONTEND_URL` must be the public https site, because PayU posts the browser back to it.
- **Razorpay**: event `payment_link.paid` (optionally `payment_link.expired`, `payment_link.cancelled`); its secret is `RAZORPAY_WEBHOOK_SECRET`.
- **Cashfree**: Payment Link events; signed with `CASHFREE_SECRET_KEY`. Use `CASHFREE_ENV=sandbox` with test keys.
- **Stripe**: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`; secret `STRIPE_WEBHOOK_SECRET`.

Premium games are listed in `src/billing/game-catalog.ts`; keep it in step with `games` in the web app when a new game ships.

**Admins** are the emails in `ADMIN_EMAILS`, and only once that account's email is verified (signed up with the emailed code, or with Google).

## Set up Google sign-in

1. Google Cloud console → APIs & Services → **OAuth consent screen**: configure it (scopes `openid`, `email`, `profile`).
2. **Credentials** → Create credentials → OAuth client ID → *Web application*.
   - Authorised redirect URI: `http://localhost:3000/api/auth/google/callback` (and your production `https://<your-domain>/api/auth/google/callback`).
3. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, keep `GOOGLE_CALLBACK_URL` equal to that redirect URI, and restart. The Google button appears in the app.

## Production checklist

- New, different random values for the four secrets; never reuse the development ones.
- A real SMTP provider and a `MAIL_FROM` on a domain you've set up SPF/DKIM for, so codes don't land in spam.
- Serve over https and leave `COOKIE_SECURE` unset (it defaults to `true`).
- Set `FRONTEND_URL` and `GOOGLE_CALLBACK_URL` to the real domain, and set `BACKEND_URL` in the web app to where this API runs.
- Restrict MongoDB network access to the API's servers.
#   P l a y - a n d - L e a r n - B a c k e n d 
 
 