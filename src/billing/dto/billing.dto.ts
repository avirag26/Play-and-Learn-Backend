import { Transform } from 'class-transformer';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { gameIds } from '../game-catalog.js';

export class CheckoutDto {
  /** Needed only by gateways that ask for it (Cashfree). Indian mobile numbers: 10 digits, optional +91. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value))
  @Matches(/^(\+91)?[6-9]\d{9}$/, { message: 'Enter a valid 10-digit mobile number.' })
  phone?: string;
}

/** Sent by the browser when the checkout popup finishes. The razorpay* fields are Razorpay's signed handler response; Cashfree sends none. */
export class ConfirmCheckoutDto {
  @IsString()
  @Matches(/^[a-f0-9]{24}$/, { message: 'Unknown payment.' })
  paymentId: string;

  @IsOptional()
  @IsString()
  @Matches(/^order_[A-Za-z0-9]{1,40}$/)
  razorpayOrderId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^pay_[A-Za-z0-9]{1,40}$/)
  razorpayPaymentId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  razorpaySignature?: string;
}

export class UpdatePlanDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Enter a plan name.' })
  @MaxLength(60)
  name: string;

  /** In paise: ₹1 to ₹1,00,000. */
  @IsInt({ message: 'The price must be a whole number of paise.' })
  @Min(100, { message: 'The price must be at least ₹1.' })
  @Max(10_000_000, { message: 'The price must be at most ₹1,00,000.' })
  amount: number;

  @IsInt()
  @Min(1, { message: 'Premium must last at least 1 day.' })
  @Max(3650, { message: 'Premium can last at most 3650 days.' })
  durationDays: number;

  @IsArray()
  @ArrayUnique()
  @IsIn(gameIds, { each: true, message: 'Unknown game selected.' })
  premiumGameIds: string[];

  @IsBoolean()
  missionsPremium: boolean;

  /** Free mission days before Premium is needed: 0 to 18 (there are 18 missions). */
  @IsInt({ message: 'Free mission days must be a whole number.' })
  @Min(0, { message: 'Free mission days can be 0 or more.' })
  @Max(18, { message: 'There are only 18 missions.' })
  freeMissionDays: number;

  @IsBoolean()
  active: boolean;
}
