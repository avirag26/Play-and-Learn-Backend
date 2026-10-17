import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import type { Env } from '../config/env.js';
import { UsersModule } from '../users/users.module.js';
import { AdminController } from './admin.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { Payment, PaymentSchema } from './payment.schema.js';
import { PlanSettings, PlanSettingsSchema } from './plan-settings.schema.js';
import { createPaymentProvider } from './providers/payment-provider.factory.js';
import { PAYMENT_PROVIDER } from './providers/payment-provider.js';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: PlanSettings.name, schema: PlanSettingsSchema },
      { name: Payment.name, schema: PaymentSchema },
    ]),
  ],
  controllers: [BillingController, AdminController],
  providers: [BillingService, { provide: PAYMENT_PROVIDER, inject: [ConfigService], useFactory: (config: ConfigService<Env, true>) => createPaymentProvider(config) }],
})
export class BillingModule {}
