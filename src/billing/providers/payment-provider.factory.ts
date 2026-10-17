import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { CashfreeProvider } from './cashfree.provider.js';
import { FakeProvider } from './fake.provider.js';
import type { PaymentProvider } from './payment-provider.js';
import { RazorpayProvider } from './razorpay.provider.js';
import { StripeProvider } from './stripe.provider.js';

/**
 * Picks the payment gateway from PAYMENT_PROVIDER. Adding or swapping a gateway means writing one
 * class that implements PaymentProvider and adding one line here. Returns null when payments are off.
 */
export function createPaymentProvider(config: ConfigService<Env, true>): PaymentProvider | null {
  const name = config.get('PAYMENT_PROVIDER', { infer: true });
  const need = (key: keyof Env): string => {
    const value = config.get(key, { infer: true }) as unknown;
    if (typeof value !== 'string' || !value) throw new Error(`PAYMENT_PROVIDER=${name} needs ${key} in .env`);
    return value;
  };

  switch (name) {
    case 'razorpay':
      return new RazorpayProvider({ keyId: need('RAZORPAY_KEY_ID'), keySecret: need('RAZORPAY_KEY_SECRET'), webhookSecret: need('RAZORPAY_WEBHOOK_SECRET') });
    case 'cashfree':
      return new CashfreeProvider({ appId: need('CASHFREE_APP_ID'), secretKey: need('CASHFREE_SECRET_KEY'), environment: config.get('CASHFREE_ENV', { infer: true }) });
    case 'stripe':
      return new StripeProvider({ secretKey: need('STRIPE_SECRET_KEY'), webhookSecret: need('STRIPE_WEBHOOK_SECRET') });
    case 'fake':
      if (config.get('NODE_ENV', { infer: true }) === 'production') throw new Error('PAYMENT_PROVIDER=fake is for development only');
      return new FakeProvider(new URL('/api/billing/fake-checkout', config.get('FRONTEND_URL', { infer: true })).toString());
    default:
      return null;
  }
}
