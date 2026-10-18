import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { PendingRegistration, PendingRegistrationSchema } from '../auth/pending-registration.schema.js';
import { RefreshToken, RefreshTokenSchema } from '../auth/refresh-token.schema.js';
import { Payment, PaymentSchema } from '../billing/payment.schema.js';
import { MailModule } from '../mail/mail.module.js';
import { UsersModule } from '../users/users.module.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';

/** Self-service account deletion; touches every collection that holds a parent's data. */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    MailModule,
    MongooseModule.forFeature([
      { name: RefreshToken.name, schema: RefreshTokenSchema },
      { name: PendingRegistration.name, schema: PendingRegistrationSchema },
      { name: Payment.name, schema: PaymentSchema },
    ]),
  ],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
