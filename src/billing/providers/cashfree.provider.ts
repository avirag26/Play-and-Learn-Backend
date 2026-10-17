import { createHmac, timingSafeEqual } from 'node:crypto';
import { gatewayRequest, header, InvalidWebhookError, PaymentGatewayError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent, type WebhookHeaders } from './payment-provider.js';

type PaymentLink = { link_id: string; link_url: string; link_status: 'ACTIVE' | 'PAID' | 'PARTIALLY_PAID' | 'EXPIRED' | 'CANCELLED' };

export type CashfreeConfig = { appId: string; secretKey: string; environment: 'sandbox' | 'production' };

const API_VERSION = '2023-08-01';
/** Webhooks older than this are rejected, so a captured one cannot be replayed later. */
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Cashfree Payment Links: a hosted page that sends the browser back to `returnUrl`.
 * Docs: https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/create
 * Webhook: add the "Payment Link" events in the Cashfree dashboard; they are signed with the secret key.
 */
export class CashfreeProvider implements PaymentProvider {
  readonly name = 'cashfree' as const;
  readonly requiresPhone = true;
  private readonly baseUrl: string;

  constructor(private readonly config: CashfreeConfig) {
    this.baseUrl = config.environment === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    if (!request.customer.phone) throw new PaymentGatewayError('Cashfree needs the customer phone number');
    const link = await this.call<PaymentLink>('POST', '/links', {
      link_id: request.reference,
      // Cashfree takes rupees, not paise.
      link_amount: request.amount / 100,
      link_currency: request.currency,
      link_purpose: request.description,
      customer_details: { customer_name: request.customer.name, customer_email: request.customer.email, customer_phone: request.customer.phone },
      link_notify: { send_sms: false, send_email: false },
      link_meta: { return_url: request.returnUrl },
      link_notes: { userId: request.customer.id },
    });
    return { providerRef: link.link_id, url: link.link_url };
  }

  async fetchStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    const link = await this.call<PaymentLink>('GET', `/links/${encodeURIComponent(providerRef)}`);
    return toStatus(link.link_status);
  }

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookEvent {
    const signature = header(headers, 'x-webhook-signature') ?? '';
    const timestamp = header(headers, 'x-webhook-timestamp') ?? '';
    const expected = createHmac('sha256', this.config.secretKey).update(timestamp).update(rawBody).digest('base64');
    if (!timestamp || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new InvalidWebhookError('Cashfree signature mismatch');
    if (Math.abs(Date.now() - Number(timestamp)) > WEBHOOK_TOLERANCE_MS) throw new InvalidWebhookError('Cashfree webhook is too old');
    const event = JSON.parse(rawBody.toString('utf8')) as { type?: string; data?: { link_id?: string; link_status?: PaymentLink['link_status'] } };
    if (event.type !== 'PAYMENT_LINK_EVENT' || !event.data?.link_id || !event.data.link_status) return null;
    return { providerRef: event.data.link_id, status: toStatus(event.data.link_status) };
  }

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return gatewayRequest<T>('Cashfree', `${this.baseUrl}${path}`, {
      method,
      headers: { 'x-client-id': this.config.appId, 'x-client-secret': this.config.secretKey, 'x-api-version': API_VERSION, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

function toStatus(status: PaymentLink['link_status']): ProviderPaymentStatus {
  if (status === 'PAID') return 'paid';
  return status === 'EXPIRED' || status === 'CANCELLED' ? 'failed' : 'pending';
}
