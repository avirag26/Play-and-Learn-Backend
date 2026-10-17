import 'reflect-metadata';
import { validateEnv } from './env.js';

const required = { MONGO_URI: 'mongodb://localhost:27017/play-and-learn', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), COOKIE_SECRET: 'c'.repeat(32), OTP_SECRET: 'o'.repeat(32) };

describe('validateEnv', () => {
  it('reads numbers from environment strings and applies defaults', () => {
    const env = validateEnv({ ...required, PORT: '4567', ACCESS_TOKEN_TTL: '600' });
    expect(env.PORT).toBe(4567);
    expect(env.ACCESS_TOKEN_TTL).toBe(600);
    expect(env.REFRESH_TOKEN_TTL).toBe(30 * 24 * 60 * 60);
    expect(env.COOKIE_SECURE).toBe('true');
  });

  it('refuses to start with missing or weak secrets', () => {
    expect(() => validateEnv({ ...required, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => validateEnv({ JWT_ACCESS_SECRET: 'a'.repeat(32) })).toThrow(/MONGO_URI/);
  });

  it('requires an SMTP server in production', () => {
    expect(() => validateEnv({ ...required, NODE_ENV: 'production' })).toThrow(/SMTP_HOST/);
    expect(validateEnv({ ...required, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com' }).SMTP_PORT).toBe(587);
  });
});
