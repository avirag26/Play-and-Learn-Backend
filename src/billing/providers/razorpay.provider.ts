import { createHmac, timingSafeEqual } from 'node:crypto';
import { gatewayRequest, header, InvalidWebhookError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent, type WebhookHeaders } from './payment-provider.js';

type PaymentLink = { id: string; short_url: string; status: 'created' | 'partially_paid' | 'expired' | 'cancelled' | 'paid' };

export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret: string };

/**
 * Razorpay Payment Links: a hosted page that sends the browser back to `returnUrl`.
 * Docs: https://razorpay.com/docs/api/payments/payment-links/
 * Webhook: subscribe to `payment_link.paid` (and optionally `payment_link.expired` / `payment_link.cancelled`).
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  readonly requiresPhone = false;
  private readonly baseUrl = 'https://api.razorpay.com/v1';

  constructor(private readonly config: RazorpayConfig) {}

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const link = await this.call<PaymentLink>('POST', '/payment_links', {
      amount: request.amount,
      currency: request.currency,
      description: request.description,
      reference_id: request.reference,
      customer: { name: request.customer.name, email: request.customer.email, ...(request.customer.phone ? { contact: request.customer.phone } : {}) },
      notify: { sms: false, email: false },
      callback_url: request.returnUrl,
      callback_method: 'get',
      notes: { userId: request.customer.id },
    });
    return { providerRef: link.id, url: link.short_url };
  }

  async fetchStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    const link = await this.call<PaymentLink>('GET', `/payment_links/${encodeURIComponent(providerRef)}`);
    return toStatus(link.status);
  }

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookEvent {
    const signature = header(headers, 'x-razorpay-signature') ?? '';
    const expected = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new InvalidWebhookError('Razorpay signature mismatch');
    const event = JSON.parse(rawBody.toString('utf8')) as { event?: string; payload?: { payment_link?: { entity?: PaymentLink } } };
    const link = event.payload?.payment_link?.entity;
    if (!event.event?.startsWith('payment_link.') || !link?.id) return null;
    return { providerRef: link.id, status: toStatus(link.status) };
  }

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    return gatewayRequest<T>('Razorpay', `${this.baseUrl}${path}`, { method, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  }
}

function toStatus(status: PaymentLink['status']): ProviderPaymentStatus {
  if (status === 'paid') return 'paid';
  return status === 'expired' || status === 'cancelled' ? 'failed' : 'pending';
}
