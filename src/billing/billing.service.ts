import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import type { Env } from '../config/env.js';
import { UsersService } from '../users/users.service.js';
import type { UpdatePlanDto } from './dto/billing.dto.js';
import { gameCatalog } from './game-catalog.js';
import { Payment, type PaymentDocument, type PaymentStatus } from './payment.schema.js';
import { defaultPlan, PLAN_KEY, PlanSettings } from './plan-settings.schema.js';
import { InvalidWebhookError, PAYMENT_PROVIDER, type HostedForm, type PaymentProvider, type PopupCheckout, type PopupProof, type WebhookHeaders } from './providers/payment-provider.js';

export type Plan = typeof defaultPlan & { updatedAt: string | null; updatedBy: string | null };

/** What parents and the game screens need to know about Premium. */
export type PublicPlan = {
  name: string;
  amount: number;
  currency: string;
  durationDays: number;
  premiumGameIds: string[];
  /** Whether parents can buy right now (plan switched on and a gateway configured). */
  available: boolean;
  requiresPhone: boolean;
};

/** A page to send the browser to, a form for it to post to the gateway, or what it needs to open the gateway's popup. */
export type CheckoutStart = { url: string } | { form: HostedForm } | { paymentId: string; popup: PopupCheckout & { name: string; description: string; prefill: { name: string; email: string } } };

export type AdminPayment = { id: string; email: string | null; provider: string; amount: number; currency: string; durationDays: number; status: PaymentStatus; createdAt: string; paidAt: string | null };
export type AdminOverview = { activePremium: number; paidCount: number; revenue: { currency: string; amount: number }[]; payments: AdminPayment[]; provider: string | null };

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @InjectModel(PlanSettings.name) private readonly plans: Model<PlanSettings>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    private readonly users: UsersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get providerName(): string | null {
    return this.provider?.name ?? null;
  }

  async getPlan(): Promise<Plan> {
    const saved = await this.plans.findOne({ key: PLAN_KEY }).lean().exec();
    if (!saved) return { ...defaultPlan, updatedAt: null, updatedBy: null };
    return { name: saved.name, amount: saved.amount, currency: saved.currency, durationDays: saved.durationDays, premiumGameIds: saved.premiumGameIds.filter((id) => gameCatalog.some((game) => game.id === id)), active: saved.active, updatedAt: saved.updatedAt?.toISOString() ?? null, updatedBy: saved.updatedBy };
  }

  async getPublicPlan(): Promise<PublicPlan> {
    const plan = await this.getPlan();
    return { name: plan.name, amount: plan.amount, currency: plan.currency, durationDays: plan.durationDays, premiumGameIds: plan.premiumGameIds, available: plan.active && this.provider !== null, requiresPhone: this.provider?.requiresPhone ?? false };
  }

  async updatePlan(dto: UpdatePlanDto, adminEmail: string): Promise<Plan> {
    await this.plans
      .updateOne({ key: PLAN_KEY }, { $set: { name: dto.name, amount: dto.amount, durationDays: dto.durationDays, premiumGameIds: dto.premiumGameIds, active: dto.active, updatedBy: adminEmail }, $setOnInsert: { key: PLAN_KEY, currency: defaultPlan.currency } }, { upsert: true })
      .exec();
    this.logger.log(`Plan updated by ${adminEmail}: ${dto.amount} paise for ${dto.durationDays} days, premium games [${dto.premiumGameIds.join(', ')}], ${dto.active ? 'on sale' : 'off sale'}`);
    return this.getPlan();
  }

  /** Starts a payment: returns the gateway's hosted page, or the details for its popup. */
  async createCheckout(userId: string, phone: string | undefined): Promise<CheckoutStart> {
    const plan = await this.getPlan();
    if (!this.provider) throw new ServiceUnavailableException('Payments are not set up yet.');
    if (!plan.active) throw new ConflictException('Premium is not on sale right now.');
    if (this.provider.requiresPhone && !phone) throw new BadRequestException('Enter your mobile number to continue to payment.');
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('Account not found.');

    const payment = await this.payments.create({ userId: new Types.ObjectId(userId), provider: this.provider.name, planName: plan.name, amount: plan.amount, currency: plan.currency, durationDays: plan.durationDays });
    const description = `${plan.name} (${plan.durationDays} days)`;
    try {
      const session = await this.provider.createCheckout({
        reference: payment.id as string,
        amount: plan.amount,
        currency: plan.currency,
        description,
        customer: { id: userId, email: user.email, name: user.name, phone },
        returnUrl: new URL(`/api/billing/return?ref=${payment.id as string}`, this.config.get('FRONTEND_URL', { infer: true })).toString(),
      });
      await this.payments.updateOne({ _id: payment._id }, { $set: { providerRef: session.providerRef } }).exec();
      if ('popup' in session) return { paymentId: payment.id as string, popup: { ...session.popup, name: plan.name, description, prefill: { name: user.name, email: user.email } } };
      return 'form' in session ? { form: session.form } : { url: session.url };
    } catch (error) {
      await this.payments.updateOne({ _id: payment._id }, { $set: { status: 'failed' } }).exec();
      this.logger.error(`Could not start a ${this.provider.name} checkout`, error instanceof Error ? error.message : String(error));
      throw new BadGatewayException("We couldn't start the payment. Please try again in a moment.");
    }
  }

  /** The browser came back from the gateway: ask the gateway how it went. */
  async confirmReturn(paymentId: string): Promise<PaymentStatus> {
    if (!isValidObjectId(paymentId)) return 'failed';
    const payment = await this.payments.findById(paymentId).exec();
    if (!payment) return 'failed';
    if (payment.status !== 'created' || !payment.providerRef || !this.provider || this.provider.name !== payment.provider) return payment.status;
    try {
      const status = await this.provider.fetchStatus(payment.providerRef);
      return status === 'pending' ? 'created' : this.settle(payment, status);
    } catch (error) {
      // The webhook will still settle it; tell the parent it is being confirmed.
      this.logger.warn(`Could not check payment ${paymentId} with ${payment.provider}: ${error instanceof Error ? error.message : String(error)}`);
      return 'created';
    }
  }

  /**
   * The popup reported a payment: check its proof with the gateway and settle. Only the parent who
   * started the payment can confirm it.
   */
  async confirmPopup(userId: string, paymentId: string, proof?: PopupProof): Promise<PaymentStatus> {
    if (!isValidObjectId(paymentId)) throw new NotFoundException('Payment not found.');
    const payment = await this.payments.findOne({ _id: paymentId, userId: new Types.ObjectId(userId) }).exec();
    if (!payment) throw new NotFoundException('Payment not found.');
    if (payment.status === 'paid') return 'paid';
    if (!payment.providerRef || !this.provider?.confirmPopup || this.provider.name !== payment.provider) throw new BadRequestException('This payment cannot be confirmed here.');
    try {
      const status = await this.provider.confirmPopup(payment.providerRef, proof);
      return status === 'pending' ? 'created' : this.settle(payment, status);
    } catch (error) {
      if (error instanceof InvalidWebhookError) {
        this.logger.warn(`Rejected popup confirmation for payment ${paymentId}: ${error.message}`);
        throw new BadRequestException("We couldn't verify this payment.");
      }
      // The webhook will still settle it; tell the parent it is being confirmed.
      this.logger.warn(`Could not confirm payment ${paymentId} with ${payment.provider}: ${error instanceof Error ? error.message : String(error)}`);
      return 'created';
    }
  }

  /** Throws InvalidWebhookError for unsigned or forged requests. */
  async handleWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<void> {
    if (!this.provider) throw new ServiceUnavailableException('Payments are not set up.');
    const event = this.provider.parseWebhook(rawBody, headers);
    if (!event || event.status === 'pending') return;
    const payment = await this.payments.findOne({ provider: this.provider.name, providerRef: event.providerRef }).exec();
    if (!payment) {
      this.logger.warn(`Webhook for unknown ${this.provider.name} checkout ${event.providerRef}`);
      return;
    }
    await this.settle(payment, event.status);
  }

  /** Records the final result once; Premium is granted only by the call that marks it paid. */
  private async settle(payment: PaymentDocument, status: 'paid' | 'failed'): Promise<PaymentStatus> {
    if (status === 'failed') {
      await this.payments.updateOne({ _id: payment._id, status: 'created' }, { $set: { status: 'failed' } }).exec();
      return (await this.payments.findById(payment._id).lean().exec())?.status ?? 'failed';
    }
    // A failed attempt can still turn out paid (e.g. a late bank confirmation), so only "paid" is final.
    const claimed = await this.payments.updateOne({ _id: payment._id, status: { $ne: 'paid' } }, { $set: { status: 'paid', paidAt: new Date() } }).exec();
    // A deleted account has nobody left to give Premium to.
    if (claimed.modifiedCount === 1 && payment.userId) {
      await this.users.extendPremium(String(payment.userId), payment.planName, payment.durationDays);
      this.logger.log(`Payment ${payment.id as string} paid: ${payment.durationDays} days of Premium for user ${String(payment.userId)}`);
    }
    return 'paid';
  }

  async adminOverview(limit = 50): Promise<AdminOverview> {
    const [recent, activePremium, totals] = await Promise.all([
      this.payments.find().sort({ createdAt: -1 }).limit(limit).lean().exec(),
      this.users.countActivePremium(),
      this.payments.aggregate<{ _id: string; amount: number; count: number }>([{ $match: { status: 'paid' } }, { $group: { _id: '$currency', amount: { $sum: '$amount' }, count: { $sum: 1 } } }]).exec(),
    ]);
    const emails = await this.users.emailsByIds([...new Set(recent.flatMap((payment) => payment.userId ? [String(payment.userId)] : []))]);
    return {
      activePremium,
      paidCount: totals.reduce((sum, total) => sum + total.count, 0),
      revenue: totals.map((total) => ({ currency: total._id, amount: total.amount })),
      provider: this.providerName,
      payments: recent.map((payment) => ({ id: String(payment._id), email: payment.userId ? emails.get(String(payment.userId)) ?? null : null, provider: payment.provider, amount: payment.amount, currency: payment.currency, durationDays: payment.durationDays, status: payment.status, createdAt: payment.createdAt.toISOString(), paidAt: payment.paidAt?.toISOString() ?? null })),
    };
  }
}
