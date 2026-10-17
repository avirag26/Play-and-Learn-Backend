import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/** Every environment variable the API reads. Validated once at startup. */
export class Env {
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: 'development' | 'production' | 'test' = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4000;

  @IsString()
  MONGO_URI: string;

  /** Comma-separated DNS servers for Node (e.g. "8.8.8.8,1.1.1.1"), for networks where SRV lookups fail. Applied in main.ts. */
  @IsOptional()
  @IsString()
  DNS_SERVERS?: string;

  /** Database to use on the MongoDB server (the URI may leave it out). */
  @IsString()
  MONGO_DB_NAME: string = 'play-and-learn';

  /** Where the web app lives; Google sign-in redirects back here. */
  @IsUrl({ require_tld: false })
  FRONTEND_URL: string = 'http://localhost:3000';

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET: string;

  /** Signs short-lived cookies such as the Google sign-in state. */
  @IsString()
  @MinLength(32)
  COOKIE_SECRET: string;

  /** Keys the hashes of emailed sign-up codes, so a database leak cannot be brute-forced offline. */
  @IsString()
  @MinLength(32)
  OTP_SECRET: string;

  /** Access token lifetime in seconds. */
  @IsInt()
  @Min(60)
  ACCESS_TOKEN_TTL: number = 15 * 60;

  /** Refresh token lifetime in seconds. */
  @IsInt()
  @Min(60 * 60)
  REFRESH_TOKEN_TTL: number = 30 * 24 * 60 * 60;

  /** Set to "false" only for plain-http local development. */
  @IsIn(['true', 'false'])
  COOKIE_SECURE: 'true' | 'false' = 'true';

  /** Express "trust proxy" setting, so rate limits see the real client IP behind the web app's proxy. */
  @IsString()
  TRUST_PROXY: string = 'loopback, linklocal, uniquelocal';

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string;

  /** SMTP server for emails (Gmail, Brevo, Amazon SES, Resend, ...). Without it, development prints emails to the console. */
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number = 587;

  /** "true" for port 465 (TLS from the start); "false" upgrades with STARTTLS. */
  @IsIn(['true', 'false'])
  SMTP_SECURE: 'true' | 'false' = 'false';

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASS?: string;

  @IsString()
  MAIL_FROM: string = 'Play & Learn <no-reply@localhost>';

  /** Must match an authorised redirect URI in the Google Cloud console. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  GOOGLE_CALLBACK_URL?: string;
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, { enableImplicitConversion: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length) {
    const details = errors
      .map((error) => `  ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  if (env.NODE_ENV === 'production' && !env.SMTP_HOST) throw new Error('Invalid environment configuration:\n  SMTP_HOST: required in production to email sign-up codes');
  return env;
}
