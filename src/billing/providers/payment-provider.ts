/**
 * The one contract every payment gateway implements. Billing code only talks to this interface;
 * the gateway is picked with PAYMENT_PROVIDER in .env (see payment-provider.factory.ts), so switching
 * between Razorpay, Cashfree and Stripe never touches anything else.
 *
 * Every gateway is used the same way: create a hosted checkout page, send the parent there, and
 * confirm the result both when the browser comes back (fetchStatus) and from the gateway's webhook.
 */

export const paymentProviderNames = ['razorpay', 'cashfree', 'stripe', 'fake'] as const;
export type PaymentProviderName = (typeof paymentProviderNames)[number];

export type CheckoutRequest = {
  /** Our own payment id; unique per attempt. */
  reference: string;
  /** In the currency's smallest unit (paise for INR). */
  amount: number;
  /** ISO 4217, upper case (e.g. "INR"). */
  currency: string;
  description: string;
  customer: { id: string; email: string; name: string; phone?: string };
  /** Where the gateway sends the browser after payment (or cancellation). */
  returnUrl: string;
};

export type CheckoutSession = {
  /** The gateway's id for this checkout, used to check its status later. */
  providerRef: string;
  /** Hosted payment page to send the browser to. */
  url: string;
};

export type ProviderPaymentStatus = 'paid' | 'pending' | 'failed';

/** What a webhook said about a checkout; null for events billing does not care about. */
export type WebhookEvent = { providerRef: string; status: ProviderPaymentStatus } | null;

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Cashfree requires the customer's phone number; the others do not. */
  readonly requiresPhone: boolean;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  fetchStatus(providerRef: string): Promise<ProviderPaymentStatus>;
  /** Verifies the signature and reads the event. Throws {@link InvalidWebhookError} when it is not from the gateway. */
  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookEvent;
}

/** Nest injection token for the active provider (null when PAYMENT_PROVIDER is not set). */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export class InvalidWebhookError extends Error {}

/** A gateway answered with an error. The message is safe to log but not shown to parents. */
export class PaymentGatewayError extends Error {}

export function header(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Calls a gateway's JSON API and throws {@link PaymentGatewayError} with its error text on failure. */
export async function gatewayRequest<T>(gateway: string, url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new PaymentGatewayError(`${gateway} ${init.method ?? 'GET'} ${new URL(url).pathname} failed with ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}
