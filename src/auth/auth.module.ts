import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { MailModule } from '../mail/mail.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GoogleAuthService } from './google-auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PendingRegistration, PendingRegistrationSchema } from './pending-registration.schema.js';
import { RefreshToken, RefreshTokenSchema } from './refresh-token.schema.js';
import { RegistrationService } from './registration.service.js';
import { TokensService } from './tokens.service.js';

@Module({
  // Secrets are passed per call in TokensService, since access and refresh tokens use different ones.
  imports: [
    UsersModule,
    MailModule,
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: RefreshToken.name, schema: RefreshTokenSchema },
      { name: PendingRegistration.name, schema: PendingRegistrationSchema },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, RegistrationService, TokensService, GoogleAuthService, JwtAuthGuard],
  exports: [TokensService, JwtAuthGuard],
})
export class AuthModule {}
