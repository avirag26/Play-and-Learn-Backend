import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { paymentProviderNames, type PaymentProviderName } from './providers/payment-provider.js';

export const paymentStatuses = ['created', 'paid', 'failed'] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

/** One checkout attempt. Price and duration are copied from the plan, so later plan edits never change a past payment. */
@Schema({ timestamps: true })
export class Payment {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: paymentProviderNames, required: true })
  provider: PaymentProviderName;

  /** The gateway's id for the checkout; set once the gateway has created it. */
  @Prop({ type: String, default: null })
  providerRef: string | null;

  @Prop({ required: true })
  planName: string;

  /** Smallest currency unit (paise). */
  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  currency: string;

  @Prop({ required: true })
  durationDays: number;

  @Prop({ type: String, enum: paymentStatuses, default: 'created', index: true })
  status: PaymentStatus;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  createdAt: Date;
}

export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ provider: 1, providerRef: 1 }, { unique: true, partialFilterExpression: { providerRef: { $type: 'string' } } });
PaymentSchema.index({ createdAt: -1 });
