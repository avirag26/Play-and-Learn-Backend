import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Inject, NotFoundException, Post, Query, Req, Res, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { PaymentStatus } from './payment.schema.js';
import { CurrentAuth, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AccessPayload } from '../auth/tokens.service.js';
import type { Env } from '../config/env.js';
import { BillingService, type CheckoutStart, type PublicPlan } from './billing.service.js';
import { CheckoutDto, ConfirmCheckoutDto } from './dto/billing.dto.js';
import { FakeProvider } from './providers/fake.provider.js';
import { InvalidWebhookError, PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider.js';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly config: ConfigService<Env, true>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  /** Public: the price, and which games need Premium. */
  @Get('plan')
  plan(): Promise<PublicPlan> {
    return this.billing.getPublicPlan();
  }

  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  checkout(@CurrentAuth() auth: AccessPayload, @Body() dto: CheckoutDto): Promise<CheckoutStart> {
    return this.billing.createCheckout(auth.sub, dto.phone);
  }

  /** The checkout popup finished: verify what it reported and unlock Premium straight away. */
  @Post('checkout/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async confirmCheckout(@CurrentAuth() auth: AccessPayload, @Body() dto: ConfirmCheckoutDto): Promise<{ status: PaymentStatus }> {
    return { status: await this.billing.confirmPopup(auth.sub, dto.paymentId, { orderId: dto.razorpayOrderId, paymentId: dto.razorpayPaymentId, signature: dto.razorpaySignature }) };
  }

  /** The gateway sends the browser here after paying (or giving up); we confirm with the gateway and go back to the app. */
  @Get('return')
  async returnFromGateway(@Query('ref') ref: unknown, @Res() res: Response): Promise<void> {
    const status = typeof ref === 'string' ? await this.billing.confirmReturn(ref) : 'failed';
    const path = status === 'paid' ? '/premium/success' : `/grown-ups?payment=${status === 'created' ? 'pending' : 'failed'}`;
    res.redirect(new URL(path, this.config.get('FRONTEND_URL', { infer: true })).toString());
  }

  /** Gateway → API notification. Needs the exact raw body for signature checks (rawBody is enabled in main.ts). */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async webhook(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    if (!req.rawBody) throw new BadRequestException('Missing body.');
    try {
      await this.billing.handleWebhook(req.rawBody, req.headers);
    } catch (error) {
      if (error instanceof InvalidWebhookError) throw new BadRequestException('Invalid signature.');
      throw error;
    }
    return { received: true };
  }

  /** The fake gateway's "hosted page" (PAYMENT_PROVIDER=fake only, never in production). */
  @Get('fake-checkout')
  fakeCheckoutPage(@Query('ref') ref: unknown, @Res() res: Response): void {
    const request = this.provider instanceof FakeProvider && typeof ref === 'string' ? this.provider.describe(ref) : null;
    if (!request || typeof ref !== 'string') throw new NotFoundException();
    const price = new Intl.NumberFormat('en-IN', { style: 'currency', currency: request.currency }).format(request.amount / 100);
    const button = (outcome: string, label: string, color: string) => `<form method="post" action="/api/billing/fake-checkout" style="margin:0"><input type="hidden" name="ref" value="${escapeHtml(ref)}"><input type="hidden" name="outcome" value="${outcome}"><button style="width:100%;padding:14px;border:0;border-radius:999px;font-size:16px;font-weight:bold;background:${color};color:#fff;cursor:pointer">${label}</button></form>`;
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test payment</title></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#1f2937"><div style="max-width:380px;margin:48px auto;padding:28px;background:#fff;border-radius:20px">
<p style="margin:0;color:#b45309;font-weight:bold;font-size:12px;letter-spacing:.1em">TEST GATEWAY · NO REAL MONEY</p>
<h1 style="font-size:22px">${escapeHtml(request.description)}</h1><p style="font-size:30px;font-weight:bold;margin:8px 0 4px">${escapeHtml(price)}</p>
<p style="color:#6b7280;margin:0 0 24px">${escapeHtml(request.customer.email)}</p>
<div style="display:grid;gap:10px">${button('paid', 'Pay (simulate success)', '#16a34a')}${button('failed', 'Fail (simulate decline)', '#dc2626')}</div></div></body></html>`);
  }

  @Post('fake-checkout')
  fakeCheckoutComplete(@Body('ref') ref: unknown, @Body('outcome') outcome: unknown, @Res() res: Response): void {
    const next = this.provider instanceof FakeProvider && typeof ref === 'string' && (outcome === 'paid' || outcome === 'failed') ? this.provider.complete(ref, outcome) : null;
    if (!next) throw new NotFoundException();
    res.redirect(303, next);
  }
}
