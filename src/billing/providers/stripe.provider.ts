import { createHmac, timingSafeEqual } from 'node:crypto';
import { gatewayRequest, header, InvalidWebhookError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent, type WebhookHeaders } from './payment-provider.js';

type CheckoutSessionObject = { id: string; url: string | null; status: 'open' | 'complete' | 'expired'; payment_status: 'paid' | 'unpaid' | 'no_payment_required' };

export type StripeConfig = { secretKey: string; webhookSecret: string };

/** Webhooks older than this are rejected, so a captured one cannot be replayed later (Stripe's own default). */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Stripe Checkout in one-time payment mode.
 * Docs: https://docs.stripe.com/api/checkout/sessions/create
 * Webhook: subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  readonly requiresPhone = false;
  private readonly baseUrl = 'https://api.stripe.com/v1';

  constructor(private readonly config: StripeConfig) {}

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const session = await this.call<CheckoutSessionObject>('POST', '/checkout/sessions', {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': request.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(request.amount),
      'line_items[0][price_data][product_data][name]': request.description,
      customer_email: request.customer.email,
      client_reference_id: request.reference,
      'metadata[userId]': request.customer.id,
      success_url: request.returnUrl,
      cancel_url: request.returnUrl,
    });
    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { providerRef: session.id, url: session.url };
  }

  async fetchStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    return toStatus(await this.call<CheckoutSessionObject>('GET', `/checkout/sessions/${encodeURIComponent(providerRef)}`));
  }

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookEvent {
    // Header format: "t=<unix seconds>,v1=<hex hmac>[,v1=...]"
    const parts = (header(headers, 'stripe-signature') ?? '').split(',').map((part) => part.split('=') as [string, string]);
    const timestamp = parts.find(([key]) => key === 't')?.[1] ?? '';
    const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
    const expected = createHmac('sha256', this.config.webhookSecret).update(`${timestamp}.`).update(rawBody).digest('hex');
    const valid = signatures.some((signature) => signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected)));
    if (!timestamp || !valid) throw new InvalidWebhookError('Stripe signature mismatch');
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) throw new InvalidWebhookError('Stripe webhook is too old');
    const event = JSON.parse(rawBody.toString('utf8')) as { type?: string; data?: { object?: CheckoutSessionObject & { object?: string } } };
    const session = event.data?.object;
    if (!event.type?.startsWith('checkout.session.') || !session?.id) return null;
    return { providerRef: session.id, status: toStatus(session) };
  }

  private call<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<T> {
    return gatewayRequest<T>('Stripe', `${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.config.secretKey}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
  }
}

function toStatus(session: Pick<CheckoutSessionObject, 'status' | 'payment_status'>): ProviderPaymentStatus {
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return 'paid';
  return session.status === 'expired' ? 'failed' : 'pending';
}
