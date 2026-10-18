import { createHmac } from 'node:crypto';
import { CashfreeProvider } from './cashfree.provider.js';
import { InvalidWebhookError, PaymentGatewayError, type CheckoutRequest } from './payment-provider.js';
import { RazorpayProvider } from './razorpay.provider.js';
import { StripeProvider } from './stripe.provider.js';

const request: CheckoutRequest = { reference: '65f0c0ffee0000000000abcd', amount: 24_900, currency: 'INR', description: 'Premium (30 days)', customer: { id: 'user-1', email: 'parent@example.com', name: 'Sam', phone: '9876543210' }, returnUrl: 'http://localhost:3000/api/billing/return?ref=65f0c0ffee0000000000abcd' };

type Call = { url: string; init: RequestInit };
function mockFetch(responses: unknown[], status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(responses.shift()), { status }));
  });
  return calls;
}
const jsonBody = (call: Call) => JSON.parse(call.init.body as string) as Record<string, any>;
const headersOf = (call: Call) => call.init.headers as Record<string, string>;

afterEach(() => vi.unstubAllGlobals());

describe('Razorpay', () => {
  const razorpay = new RazorpayProvider({ keyId: 'rzp_test_key', keySecret: 'secret', webhookSecret: 'whsec' });
  const sign = (orderId: string, paymentId: string, secret = 'secret') => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  it('creates an order for the checkout popup and maps its status', async () => {
    const calls = mockFetch([{ id: 'order_1', amount: 24_900, currency: 'INR', status: 'created' }, { id: 'order_1', status: 'attempted' }, { id: 'order_1', status: 'paid' }]);
    expect(await razorpay.createCheckout(request)).toEqual({ providerRef: 'order_1', popup: { provider: 'razorpay', keyId: 'rzp_test_key', orderId: 'order_1', amount: 24_900, currency: 'INR' } });
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders');
    expect(headersOf(calls[0]).Authorization).toBe(`Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`);
    expect(jsonBody(calls[0])).toMatchObject({ amount: 24_900, currency: 'INR', receipt: request.reference });
    expect(await razorpay.fetchStatus('order_1')).toBe('pending');
    expect(await razorpay.fetchStatus('order_1')).toBe('paid');
  });

  it('confirms a popup payment only with a genuine signature for the same order', async () => {
    mockFetch([{ id: 'pay_1', order_id: 'order_1', amount: 24_900, currency: 'INR', status: 'captured' }]);
    expect(await razorpay.confirmPopup('order_1', { orderId: 'order_1', paymentId: 'pay_1', signature: sign('order_1', 'pay_1') })).toBe('paid');
    await expect(razorpay.confirmPopup('order_1', { orderId: 'order_1', paymentId: 'pay_1', signature: sign('order_1', 'pay_1', 'wrong') })).rejects.toThrow(InvalidWebhookError);
    await expect(razorpay.confirmPopup('order_2', { orderId: 'order_1', paymentId: 'pay_1', signature: sign('order_1', 'pay_1') })).rejects.toThrow(InvalidWebhookError);
    mockFetch([{ id: 'pay_9', order_id: 'order_other', amount: 100, currency: 'INR', status: 'captured' }]);
    await expect(razorpay.confirmPopup('order_1', { orderId: 'order_1', paymentId: 'pay_9', signature: sign('order_1', 'pay_9') })).rejects.toThrow(InvalidWebhookError);
  });

  it('captures an authorized payment so the money is actually collected', async () => {
    const calls = mockFetch([{ id: 'pay_1', order_id: 'order_1', amount: 24_900, currency: 'INR', status: 'authorized' }, { id: 'pay_1', order_id: 'order_1', amount: 24_900, currency: 'INR', status: 'captured' }]);
    expect(await razorpay.confirmPopup('order_1', { orderId: 'order_1', paymentId: 'pay_1', signature: sign('order_1', 'pay_1') })).toBe('paid');
    expect(calls[1].url).toBe('https://api.razorpay.com/v1/payments/pay_1/capture');
    expect(jsonBody(calls[1])).toEqual({ amount: 24_900, currency: 'INR' });
  });

  it('still settles payment links created before the switch', async () => {
    const calls = mockFetch([{ id: 'plink_1', status: 'paid' }]);
    expect(await razorpay.fetchStatus('plink_1')).toBe('paid');
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payment_links/plink_1');
  });

  it('accepts only correctly signed webhooks', () => {
    const signed = (event: unknown) => { const body = Buffer.from(JSON.stringify(event)); return [body, { 'x-razorpay-signature': createHmac('sha256', 'whsec').update(body).digest('hex') }] as const; };
    expect(razorpay.parseWebhook(...signed({ event: 'order.paid', payload: { order: { entity: { id: 'order_1', status: 'paid' } } } }))).toEqual({ providerRef: 'order_1', status: 'paid' });
    expect(razorpay.parseWebhook(...signed({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } } }))).toEqual({ providerRef: 'order_1', status: 'paid' });
    expect(razorpay.parseWebhook(...signed({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', status: 'paid' } } } }))).toEqual({ providerRef: 'plink_1', status: 'paid' });
    expect(razorpay.parseWebhook(...signed({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } } }))).toBeNull();
    const [body, headers] = signed({ event: 'order.paid', payload: { order: { entity: { id: 'order_1' } } } });
    expect(() => razorpay.parseWebhook(body, { 'x-razorpay-signature': headers['x-razorpay-signature'].replace(/.$/, '0') })).toThrow(InvalidWebhookError);
    expect(() => razorpay.parseWebhook(body, {})).toThrow(InvalidWebhookError);
    expect(() => new RazorpayProvider({ keyId: 'k', keySecret: 's' }).parseWebhook(body, headers)).toThrow(InvalidWebhookError);
  });

  it('reports gateway errors', async () => {
    mockFetch([{ error: { description: 'Authentication failed' } }], 401);
    await expect(razorpay.createCheckout(request)).rejects.toThrow(PaymentGatewayError);
  });
});

describe('Cashfree', () => {
  const cashfree = new CashfreeProvider({ appId: 'app', secretKey: 'cf-secret', environment: 'sandbox' });

  it('creates a payment link in rupees on the sandbox and needs a phone number', async () => {
    const calls = mockFetch([{ link_id: request.reference, link_url: 'https://payments-test.cashfree.com/links/x', link_status: 'ACTIVE' }, { link_status: 'PAID' }]);
    expect(await cashfree.createCheckout(request)).toEqual({ providerRef: request.reference, url: 'https://payments-test.cashfree.com/links/x' });
    expect(calls[0].url).toBe('https://sandbox.cashfree.com/pg/links');
    expect(headersOf(calls[0])).toMatchObject({ 'x-client-id': 'app', 'x-client-secret': 'cf-secret', 'x-api-version': '2023-08-01' });
    expect(jsonBody(calls[0])).toMatchObject({ link_id: request.reference, link_amount: 249, link_currency: 'INR', customer_details: { customer_phone: '9876543210' }, link_meta: { return_url: request.returnUrl } });
    expect(await cashfree.fetchStatus(request.reference)).toBe('paid');
    await expect(cashfree.createCheckout({ ...request, customer: { ...request.customer, phone: undefined } })).rejects.toThrow(/phone/);
  });

  it('accepts only fresh, correctly signed webhooks', () => {
    const body = Buffer.from(JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_id: 'link-1', link_status: 'PAID' } }));
    const sign = (timestamp: string) => createHmac('sha256', 'cf-secret').update(timestamp).update(body).digest('base64');
    const now = String(Date.now());
    expect(cashfree.parseWebhook(body, { 'x-webhook-timestamp': now, 'x-webhook-signature': sign(now) })).toEqual({ providerRef: 'link-1', status: 'paid' });
    expect(() => cashfree.parseWebhook(body, { 'x-webhook-timestamp': now, 'x-webhook-signature': sign('1') })).toThrow(InvalidWebhookError);
    const old = String(Date.now() - 10 * 60 * 1000);
    expect(() => cashfree.parseWebhook(body, { 'x-webhook-timestamp': old, 'x-webhook-signature': sign(old) })).toThrow(/too old/);
  });

  it('uses the live API in production', async () => {
    const calls = mockFetch([{ link_status: 'EXPIRED' }]);
    expect(await new CashfreeProvider({ appId: 'a', secretKey: 's', environment: 'production' }).fetchStatus('x')).toBe('failed');
    expect(calls[0].url).toBe('https://api.cashfree.com/pg/links/x');
  });
});

describe('Stripe', () => {
  const stripe = new StripeProvider({ secretKey: 'sk_test_123', webhookSecret: 'whsec_123' });

  it('creates a one-time Checkout Session in paise', async () => {
    const calls = mockFetch([{ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', status: 'open', payment_status: 'unpaid' }, { status: 'complete', payment_status: 'paid' }]);
    expect(await stripe.createCheckout(request)).toEqual({ providerRef: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(headersOf(calls[0]).Authorization).toBe('Bearer sk_test_123');
    const form = new URLSearchParams(calls[0].init.body as string);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('24900');
    expect(form.get('line_items[0][price_data][currency]')).toBe('inr');
    expect(form.get('client_reference_id')).toBe(request.reference);
    expect(form.get('success_url')).toBe(request.returnUrl);
    expect(await stripe.fetchStatus('cs_test_1')).toBe('paid');
  });

  it('accepts only fresh, correctly signed webhooks', () => {
    const body = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', status: 'complete', payment_status: 'paid' } } }));
    const t = Math.floor(Date.now() / 1000);
    const sign = (time: number) => createHmac('sha256', 'whsec_123').update(`${time}.`).update(body).digest('hex');
    expect(stripe.parseWebhook(body, { 'stripe-signature': `t=${t},v1=${sign(t)}` })).toEqual({ providerRef: 'cs_1', status: 'paid' });
    expect(() => stripe.parseWebhook(body, { 'stripe-signature': `t=${t},v1=${sign(t - 1)}` })).toThrow(InvalidWebhookError);
    expect(() => stripe.parseWebhook(body, { 'stripe-signature': `t=${t - 600},v1=${sign(t - 600)}` })).toThrow(/too old/);
    const expired = Buffer.from(JSON.stringify({ type: 'checkout.session.expired', data: { object: { id: 'cs_2', status: 'expired', payment_status: 'unpaid' } } }));
    expect(stripe.parseWebhook(expired, { 'stripe-signature': `t=${t},v1=${createHmac('sha256', 'whsec_123').update(`${t}.`).update(expired).digest('hex')}` })).toEqual({ providerRef: 'cs_2', status: 'failed' });
  });
});
