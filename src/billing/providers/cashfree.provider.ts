import { createHmac, timingSafeEqual } from 'node:crypto';
import { gatewayRequest, header, InvalidWebhookError, PaymentGatewayError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent, type WebhookHeaders } from './payment-provider.js';

type Order = { order_id: string; payment_session_id: string; order_status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED' };

export type CashfreeConfig = { appId: string; secretKey: string; environment: 'sandbox' | 'production' };

const API_VERSION = '2023-08-01';
/** Webhooks older than this are rejected, so a captured one cannot be replayed later. */
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Cashfree Orders with the JS checkout popup: we create an order, the browser opens Cashfree's popup
 * on our page with its payment_session_id, and we then ask Cashfree whether the order is paid.
 * Docs: https://www.cashfree.com/docs/payments/online/web/redirect
 * Webhook: add the Payment events (PAYMENT_SUCCESS_WEBHOOK) in the Cashfree dashboard; they are signed with the secret key.
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
    const order = await this.call<Order>('POST', '/orders', {
      order_id: request.reference,
      // Cashfree takes rupees, not paise.
      order_amount: request.amount / 100,
      order_currency: request.currency,
      order_note: request.description,
      customer_details: { customer_id: request.customer.id, customer_name: request.customer.name, customer_email: request.customer.email, customer_phone: request.customer.phone },
      // Used only when the popup can't open (some in-app browsers) and Cashfree redirects instead.
      order_meta: { return_url: request.returnUrl },
    });
    return { providerRef: order.order_id, popup: { provider: 'cashfree', mode: this.config.environment, paymentSessionId: order.payment_session_id, orderId: order.order_id } };
  }

  async fetchStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    const order = await this.call<Order>('GET', `/orders/${encodeURIComponent(providerRef)}`);
    if (order.order_status === 'PAID') return 'paid';
    // A failed attempt leaves the order ACTIVE for another try; only a closed order has failed.
    return order.order_status === 'EXPIRED' || order.order_status === 'TERMINATED' ? 'failed' : 'pending';
  }

  /** The popup sends nothing to trust: the answer comes straight from Cashfree. */
  confirmPopup(providerRef: string): Promise<ProviderPaymentStatus> {
    return this.fetchStatus(providerRef);
  }

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookEvent {
    const signature = header(headers, 'x-webhook-signature') ?? '';
    const timestamp = header(headers, 'x-webhook-timestamp') ?? '';
    const expected = createHmac('sha256', this.config.secretKey).update(timestamp).update(rawBody).digest('base64');
    if (!timestamp || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new InvalidWebhookError('Cashfree signature mismatch');
    if (Math.abs(Date.now() - Number(timestamp)) > WEBHOOK_TOLERANCE_MS) throw new InvalidWebhookError('Cashfree webhook is too old');
    const event = JSON.parse(rawBody.toString('utf8')) as { type?: string; data?: { order?: { order_id?: string }; payment?: { payment_status?: string } } };
    const orderId = event.data?.order?.order_id;
    if (event.type !== 'PAYMENT_SUCCESS_WEBHOOK' || !orderId || event.data?.payment?.payment_status !== 'SUCCESS') return null;
    return { providerRef: orderId, status: 'paid' };
  }

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return gatewayRequest<T>('Cashfree', `${this.baseUrl}${path}`, {
      method,
      headers: { 'x-client-id': this.config.appId, 'x-client-secret': this.config.secretKey, 'x-api-version': API_VERSION, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}
