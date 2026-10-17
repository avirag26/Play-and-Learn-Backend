import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export const PLAN_KEY = 'premium';

/** The single Premium plan, edited in the admin app. One document, found by `key`. */
@Schema({ timestamps: true, collection: 'plansettings' })
export class PlanSettings {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true, trim: true })
  name: string;

  /** Price in the currency's smallest unit (paise). */
  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  currency: string;

  /** How long one payment unlocks Premium. */
  @Prop({ required: true })
  durationDays: number;

  @Prop({ type: [String], default: [] })
  premiumGameIds: string[];

  /** Parents can only buy while this is on. Existing access is not affected. */
  @Prop({ default: false })
  active: boolean;

  @Prop({ type: String, default: null })
  updatedBy: string | null;

  updatedAt: Date;
}

export type PlanSettingsDocument = HydratedDocument<PlanSettings>;
export const PlanSettingsSchema = SchemaFactory.createForClass(PlanSettings);

/** Used until an admin saves the plan for the first time. */
export const defaultPlan = { name: 'Play & Learn Premium', amount: 19_900, currency: 'INR', durationDays: 30, premiumGameIds: [] as string[], active: false };
