import { createHmac, timingSafeEqual } from 'node:crypto';
import { gatewayRequest, header, InvalidWebhookError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type PopupProof, type ProviderPaymentStatus, type WebhookEvent, type WebhookHeaders } from './payment-provider.js';

type Order = { id: string; amount: number; currency: string; status: 'created' | 'attempted' | 'paid' };
type Payment = { id: string; order_id: string | null; amount: number; currency: string; status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed' };
/** Checkouts started before the switch to the popup used Payment Links; they still settle normally. */
type PaymentLink = { id: string; status: 'created' | 'partially_paid' | 'expired' | 'cancelled' | 'paid' };

/** Without webhookSecret, webhooks are rejected and payments are confirmed only from the browser. */
export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret?: string };

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Razorpay Standard Checkout: we create an Order, the browser opens Razorpay's popup on our page,
 * and the popup's signed result comes back to confirmPopup. Docs: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/
 * Webhook: subscribe to `order.paid` (and `payment_link.paid` while old links are still open).
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  readonly requiresPhone = false;
  private readonly baseUrl = 'https://api.razorpay.com/v1';

  constructor(private readonly config: RazorpayConfig) {}

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const order = await this.call<Order>('POST', '/orders', { amount: request.amount, currency: request.currency, receipt: request.reference, notes: { userId: request.customer.id, reference: request.reference } });
    return { providerRef: order.id, popup: { provider: 'razorpay', keyId: this.config.keyId, orderId: order.id, amount: order.amount, currency: order.currency } };
  }

  async fetchStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    if (providerRef.startsWith('plink_')) {
      const link = await this.call<PaymentLink>('GET', `/payment_links/${encodeURIComponent(providerRef)}`);
      return linkStatus(link.status);
    }
    // A failed attempt leaves the order open for another try, so only "paid" is final.
    const order = await this.call<Order>('GET', `/orders/${encodeURIComponent(providerRef)}`);
    return order.status === 'paid' ? 'paid' : 'pending';
  }

  /**
   * Checks Razorpay's signature over "order_id|payment_id" (signed with our key secret, so the browser
   * can't forge it), then makes sure the money is actually captured.
   */
  async confirmPopup(providerRef: string, proof: PopupProof): Promise<ProviderPaymentStatus> {
    const expected = createHmac('sha256', this.config.keySecret).update(`${proof.orderId}|${proof.paymentId}`).digest('hex');
    if (proof.orderId !== providerRef || !safeEqual(proof.signature, expected)) throw new InvalidWebhookError('Razorpay checkout signature mismatch');
    let payment = await this.call<Payment>('GET', `/payments/${encodeURIComponent(proof.paymentId)}`);
    if (payment.order_id !== providerRef) throw new InvalidWebhookError('Razorpay payment belongs to another order');
    // Accounts without automatic capture leave payments "authorized" (and refund them after a few days).
    if (payment.status === 'authorized') payment = await this.call<Payment>('POST', `/payments/${encodeURIComponent(payment.id)}/capture`, { amount: payment.amount, currency: payment.currency });
    return payment.status === 'captured' ? 'paid' : payment.status === 'failed' ? 'failed' : 'pending';
  }

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookEvent {
    if (!this.config.webhookSecret) throw new InvalidWebhookError('RAZORPAY_WEBHOOK_SECRET is not set');
    const expected = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex');
    if (!safeEqual(header(headers, 'x-razorpay-signature') ?? '', expected)) throw new InvalidWebhookError('Razorpay signature mismatch');
    const event = JSON.parse(rawBody.toString('utf8')) as { event?: string; payload?: { order?: { entity?: Order }; payment?: { entity?: Payment }; payment_link?: { entity?: PaymentLink } } };
    if (event.event === 'order.paid' && event.payload?.order?.entity?.id) return { providerRef: event.payload.order.entity.id, status: 'paid' };
    if (event.event === 'payment.captured' && event.payload?.payment?.entity?.order_id) return { providerRef: event.payload.payment.entity.order_id, status: 'paid' };
    const link = event.payload?.payment_link?.entity;
    if (event.event?.startsWith('payment_link.') && link?.id) return { providerRef: link.id, status: linkStatus(link.status) };
    return null;
  }

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    return gatewayRequest<T>('Razorpay', `${this.baseUrl}${path}`, { method, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  }
}

function linkStatus(status: PaymentLink['status']): ProviderPaymentStatus {
  if (status === 'paid') return 'paid';
  return status === 'expired' || status === 'cancelled' ? 'failed' : 'pending';
}
