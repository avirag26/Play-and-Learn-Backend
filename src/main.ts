import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { configureApp } from './configure-app.js';
import { setServers } from 'node:dns';

async function bootstrap() {
  // On some networks Node cannot use the system's DNS server and falls back to 127.0.0.1, which breaks
  // MongoDB Atlas "mongodb+srv://" lookups. DNS_SERVERS overrides it. Importing AppModule has already
  // loaded .env, and this must run before the database connects.
  const dnsServers = process.env.DNS_SERVERS?.split(',').map((server) => server.trim()).filter(Boolean);
  if (dnsServers?.length) setServers(dnsServers);

  // rawBody: payment webhooks are verified against the exact bytes the gateway signed.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  await app.listen(app.get<ConfigService<Env, true>>(ConfigService).get('PORT', { infer: true }));
}
await bootstrap();
