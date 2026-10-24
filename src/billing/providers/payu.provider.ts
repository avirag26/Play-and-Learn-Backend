import { createHash, timingSafeEqual } from 'node:crypto';
import { gatewayRequest, InvalidWebhookError, PaymentGatewayError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent } from './payment-provider.js';

type Transaction = { txnid?: string; status?: string };
type VerifyResponse = { status?: number; msg?: string; transaction_details?: Record<string, Transaction | undefined> };

export type PayuConfig = { merchantKey: string; merchantSalt: string; environment: 'test' | 'production' };

const sha512 = (fields: string[]) => createHash('sha512').update(fields.join('|')).digest('hex');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** PayU rejects some punctuation in these fields, and the hash must cover exactly what is sent. */
const plain = (value: string, fallback: string) => value.replace(/[^A-Za-z0-9 .,_-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;

/**
 * PayU Hosted Checkout: the browser posts a form signed with our salt to PayU's payment page, PayU posts
 * the browser back to returnUrl, and we then ask PayU (verify_payment) whether it was paid.
 * Docs: https://docs.payu.in/docs/hosted-checkout-merchant-integration
 * Webhook: Dashboard > Developers > Webhooks, "Successful" and "Failed" payment events, URL /api/billing/webhook.
 * PayU signs it with the same reverse hash as its redirect, using our salt.
 */
export class PayuProvider implements PaymentProvider {
  readonly name = 'payu' as const;
  /** PayU's hosted page requires the customer's phone number. */
  readonly requiresPhone = true;
  private readonly checkoutUrl: string;
  private readonly verifyUrl: string;

  constructor(private readonly config: PayuConfig) {
    const live = config.environment === 'production';
    this.checkoutUrl = live ? 'https://secure.payu.in/_payment' : 'https://test.payu.in/_payment';
    this.verifyUrl = live ? 'https://info.payu.in/merchant/postservice.php?form=2' : 'https://test.payu.in/merchant/postservice.php?form=2';
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    if (!request.customer.phone) throw new PaymentGatewayError('PayU needs the customer phone number');
    const { merchantKey: key, merchantSalt: salt } = this.config;
    // Our payment id (24 characters) fits PayU's 25-character txnid.
    const txnid = request.reference;
    // PayU takes rupees with two decimals, not paise.
    const amount = (request.amount / 100).toFixed(2);
    const productinfo = plain(request.description, 'Premium');
    const firstname = plain(request.customer.name, 'Parent');
    const email = request.customer.email;
    const udf1 = request.customer.id;
    const hash = sha512([key, txnid, amount, productinfo, firstname, email, udf1, '', '', '', '', '', '', '', '', '', salt]);
    const fields = { key, txnid, amount, productinfo, firstname, email, phone: request.customer.phone.replace(/^\+91/, ''), udf1, surl: request.returnUrl, furl: request.returnUrl, hash };
    return { providerRef: txnid, form: { action: this.checkoutUrl, fields } };
  }

  async fetchStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    const { merchantKey: key, merchantSalt: salt } = this.config;
    const command = 'verify_payment';
    const body = new URLSearchParams({ key, command, var1: providerRef, hash: sha512([key, command, providerRef, salt]) });
    const result = await gatewayRequest<VerifyResponse>('PayU', this.verifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() });
    const transaction = result.transaction_details?.[providerRef];
    if (!transaction) throw new PaymentGatewayError(`PayU verify_payment answered without the transaction: ${result.msg ?? 'no message'}`);
    return transactionStatus(transaction.status);
  }

  /** PayU's reverse hash: SALT|status||||||udf5|...|udf1|email|firstname|productinfo|amount|txnid|key, prefixed by additional charges when there are any. */
  parseWebhook(rawBody: Buffer): WebhookEvent {
    const text = rawBody.toString('utf8');
    const event: Record<string, string | undefined> = text.trimStart().startsWith('{') ? (JSON.parse(text) as Record<string, string>) : Object.fromEntries(new URLSearchParams(text));
    const field = (name: string) => String(event[name] ?? '');
    const charges = field('additionalCharges') || field('additional_charges');
    const signed = [this.config.merchantSalt, field('status'), '', '', '', '', '', field('udf5'), field('udf4'), field('udf3'), field('udf2'), field('udf1'), field('email'), field('firstname'), field('productinfo'), field('amount'), field('txnid'), field('key')];
    const expected = sha512(charges ? [charges, ...signed] : signed);
    if (field('key') !== this.config.merchantKey || !safeEqual(field('hash').toLowerCase(), expected)) throw new InvalidWebhookError('PayU hash mismatch');
    const status = transactionStatus(field('status'));
    return field('txnid') && status !== 'pending' ? { providerRef: field('txnid'), status } : null;
  }
}

function transactionStatus(status: string | undefined): ProviderPaymentStatus {
  if (status === 'success') return 'paid';
  // "pending" and "Not Found" (the parent left before paying) can still change.
  return status === 'failure' ? 'failed' : 'pending';
}
