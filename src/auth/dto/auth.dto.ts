import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normalisedEmail = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class LoginDto {
  @Transform(normalisedEmail)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(1, { message: 'Enter your password.' })
  @MaxLength(128)
  password: string;
}

export class RegisterDto {
  @Transform(normalisedEmail)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for the password.' })
  @MaxLength(128, { message: 'Use at most 128 characters for the password.' })
  password: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Enter your name.' })
  @MaxLength(80)
  name: string;
}

export class ResendCodeDto {
  @Transform(normalisedEmail)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email: string;
}

export class VerifyCodeDto {
  @Transform(normalisedEmail)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email: string;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/\s/g, '') : value))
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from the email.' })
  code: string;
}
