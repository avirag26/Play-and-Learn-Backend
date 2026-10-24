import { createHash, createHmac } from 'node:crypto';
import { CashfreeProvider } from './cashfree.provider.js';
import { InvalidWebhookError, PaymentGatewayError, type CheckoutRequest } from './payment-provider.js';
import { PayuProvider } from './payu.provider.js';
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

  it('creates an order for the checkout popup in rupees on the sandbox, and needs a phone number', async () => {
    const calls = mockFetch([{ order_id: request.reference, payment_session_id: 'session_abc', order_status: 'ACTIVE' }]);
    expect(await cashfree.createCheckout(request)).toEqual({ providerRef: request.reference, popup: { provider: 'cashfree', mode: 'sandbox', paymentSessionId: 'session_abc', orderId: request.reference } });
    expect(calls[0].url).toBe('https://sandbox.cashfree.com/pg/orders');
    expect(headersOf(calls[0])).toMatchObject({ 'x-client-id': 'app', 'x-client-secret': 'cf-secret', 'x-api-version': '2023-08-01' });
    expect(jsonBody(calls[0])).toMatchObject({ order_id: request.reference, order_amount: 249, order_currency: 'INR', customer_details: { customer_id: 'user-1', customer_phone: '9876543210' }, order_meta: { return_url: request.returnUrl } });
    await expect(cashfree.createCheckout({ ...request, customer: { ...request.customer, phone: undefined } })).rejects.toThrow(/phone/);
  });

  it('confirms the popup by asking Cashfree for the order status', async () => {
    const calls = mockFetch([{ order_status: 'PAID' }, { order_status: 'ACTIVE' }, { order_status: 'EXPIRED' }, { order_status: 'TERMINATED' }]);
    expect(await cashfree.confirmPopup(request.reference)).toBe('paid');
    expect(calls[0].url).toBe(`https://sandbox.cashfree.com/pg/orders/${request.reference}`);
    expect(await cashfree.fetchStatus(request.reference)).toBe('pending');
    expect(await cashfree.fetchStatus(request.reference)).toBe('failed');
    expect(await cashfree.fetchStatus(request.reference)).toBe('failed');
  });

  it('accepts only fresh, correctly signed payment webhooks', () => {
    const body = Buffer.from(JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'order-1' }, payment: { payment_status: 'SUCCESS' } } }));
    const sign = (timestamp: string, payload = body) => createHmac('sha256', 'cf-secret').update(timestamp).update(payload).digest('base64');
    const now = String(Date.now());
    expect(cashfree.parseWebhook(body, { 'x-webhook-timestamp': now, 'x-webhook-signature': sign(now) })).toEqual({ providerRef: 'order-1', status: 'paid' });
    expect(() => cashfree.parseWebhook(body, { 'x-webhook-timestamp': now, 'x-webhook-signature': sign('1') })).toThrow(InvalidWebhookError);
    const old = String(Date.now() - 10 * 60 * 1000);
    expect(() => cashfree.parseWebhook(body, { 'x-webhook-timestamp': old, 'x-webhook-signature': sign(old) })).toThrow(/too old/);
    const failed = Buffer.from(JSON.stringify({ type: 'PAYMENT_FAILED_WEBHOOK', data: { order: { order_id: 'order-1' }, payment: { payment_status: 'FAILED' } } }));
    expect(cashfree.parseWebhook(failed, { 'x-webhook-timestamp': now, 'x-webhook-signature': sign(now, failed) })).toBeNull();
  });

  it('uses the production API in production', async () => {
    const calls = mockFetch([{ order_status: 'ACTIVE' }]);
    expect(await new CashfreeProvider({ appId: 'a', secretKey: 's', environment: 'production' }).fetchStatus('x')).toBe('pending');
    expect(calls[0].url).toBe('https://api.cashfree.com/pg/orders/x');
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

describe('PayU', () => {
  const payu = new PayuProvider({ merchantKey: 'mkey', merchantSalt: 'msalt', environment: 'production' });
  const sha512 = (text: string) => createHash('sha512').update(text).digest('hex');
  const ref = request.reference;

  it('signs a hosted checkout form for the live page in rupees, and needs a phone number', async () => {
    const session = await payu.createCheckout({ ...request, customer: { ...request.customer, name: 'Sam <O\'Neil>', phone: '+919876543210' } });
    expect(session).toMatchObject({ providerRef: ref, form: { action: 'https://secure.payu.in/_payment' } });
    if (!('form' in session)) throw new Error('expected a form');
    const fields = session.form.fields;
    expect(fields).toMatchObject({ key: 'mkey', txnid: ref, amount: '249.00', productinfo: 'Premium 30 days', firstname: 'Sam O Neil', email: 'parent@example.com', phone: '9876543210', udf1: 'user-1', surl: request.returnUrl, furl: request.returnUrl });
    // PayU's documented formula: key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
    expect(fields.hash).toBe(sha512(`mkey|${ref}|249.00|Premium 30 days|Sam O Neil|parent@example.com|user-1||||||||||msalt`));
    await expect(payu.createCheckout({ ...request, customer: { ...request.customer, phone: undefined } })).rejects.toThrow(PaymentGatewayError);
    const test = await new PayuProvider({ merchantKey: 'k', merchantSalt: 's', environment: 'test' }).createCheckout(request);
    expect('form' in test && test.form.action).toBe('https://test.payu.in/_payment');
  });

  it('asks verify_payment for the result', async () => {
    const calls = mockFetch([{ status: 1, transaction_details: { [ref]: { txnid: ref, status: 'success' } } }, { status: 1, transaction_details: { [ref]: { status: 'failure' } } }, { status: 0, transaction_details: { [ref]: { status: 'Not Found' } } }, { status: 0, msg: 'Invalid Hash.' }]);
    expect(await payu.fetchStatus(ref)).toBe('paid');
    expect(calls[0].url).toBe('https://info.payu.in/merchant/postservice.php?form=2');
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body as string))).toEqual({ key: 'mkey', command: 'verify_payment', var1: ref, hash: sha512(`mkey|verify_payment|${ref}|msalt`) });
    expect(await payu.fetchStatus(ref)).toBe('failed');
    expect(await payu.fetchStatus(ref)).toBe('pending');
    await expect(payu.fetchStatus(ref)).rejects.toThrow(PaymentGatewayError);
  });

  it('accepts only webhooks with a genuine reverse hash', () => {
    const base = { key: 'mkey', txnid: ref, amount: '249.00', productinfo: 'Premium 30 days', firstname: 'Sam', email: 'parent@example.com', udf1: 'user-1', mihpayid: '403993715531' };
    // SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
    const reverse = (status: string) => sha512(`msalt|${status}${'|'.repeat(10)}user-1|parent@example.com|Sam|Premium 30 days|249.00|${ref}|mkey`);
    const form = (fields: Record<string, string>) => Buffer.from(new URLSearchParams(fields).toString());
    expect(payu.parseWebhook(form({ ...base, status: 'success', hash: reverse('success') }))).toEqual({ providerRef: ref, status: 'paid' });
    expect(payu.parseWebhook(Buffer.from(JSON.stringify({ ...base, status: 'failure', hash: reverse('failure') })))).toEqual({ providerRef: ref, status: 'failed' });
    expect(payu.parseWebhook(form({ ...base, status: 'success', additionalCharges: '5.00', hash: sha512(`5.00|msalt|success${'|'.repeat(10)}user-1|parent@example.com|Sam|Premium 30 days|249.00|${ref}|mkey`) }))).toEqual({ providerRef: ref, status: 'paid' });
    expect(payu.parseWebhook(form({ ...base, status: 'pending', hash: reverse('pending') }))).toBeNull();
    expect(() => payu.parseWebhook(form({ ...base, status: 'success', hash: reverse('failure') }))).toThrow(InvalidWebhookError);
    expect(() => payu.parseWebhook(form({ ...base, amount: '1.00', status: 'success', hash: reverse('success') }))).toThrow(InvalidWebhookError);
    expect(() => payu.parseWebhook(form({ ...base, status: 'success' }))).toThrow(InvalidWebhookError);
  });
});
