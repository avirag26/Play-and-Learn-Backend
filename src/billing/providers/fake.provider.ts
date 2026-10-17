import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { header, InvalidWebhookError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent, type WebhookHeaders } from './payment-provider.js';

/** Signs fake webhooks in tests. Not a secret: this provider never runs in production. */
export const FAKE_WEBHOOK_SECRET = 'fake-gateway-webhook-secret';

type FakeCheckout = { request: CheckoutRequest; status: ProviderPaymentStatus };

/**
 * A pretend gateway for local development and tests, so the whole payment flow works without real
 * keys. Its "hosted page" is /api/billing/fake-checkout on this API. Refused in production.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  readonly requiresPhone = false;
  private readonly checkouts = new Map<string, FakeCheckout>();

  constructor(private readonly pageUrl: string) {}

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const providerRef = `fake_${randomUUID()}`;
    this.checkouts.set(providerRef, { request, status: 'pending' });
    return Promise.resolve({ providerRef, url: `${this.pageUrl}?ref=${encodeURIComponent(providerRef)}` });
  }

  fetchStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    return Promise.resolve(this.checkouts.get(providerRef)?.status ?? 'failed');
  }

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookEvent {
    const signature = header(headers, 'x-fake-signature') ?? '';
    const expected = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new InvalidWebhookError('Fake signature mismatch');
    const event = JSON.parse(rawBody.toString('utf8')) as { providerRef?: string; status?: ProviderPaymentStatus };
    return event.providerRef && event.status ? { providerRef: event.providerRef, status: event.status } : null;
  }

  /** What the fake checkout page shows. */
  describe(providerRef: string): CheckoutRequest | null {
    return this.checkouts.get(providerRef)?.request ?? null;
  }

  /** The fake page's Pay / Fail buttons. Returns where to send the browser next. */
  complete(providerRef: string, outcome: 'paid' | 'failed'): string | null {
    const checkout = this.checkouts.get(providerRef);
    if (!checkout) return null;
    checkout.status = outcome;
    return checkout.request.returnUrl;
  }
}
