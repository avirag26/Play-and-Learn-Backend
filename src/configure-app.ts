import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Env } from './config/env.js';

/** HTTP setup shared by the server and the end-to-end tests. */
export function configureApp(app: NestExpressApplication): INestApplication {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const trustProxy = config.get('TRUST_PROXY', { infer: true });
  app.set('trust proxy', trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser(config.get('COOKIE_SECRET', { infer: true })));
  // The web app calls the API through its own /api proxy, so browsers see one origin. CORS is only
  // for calling the API directly from the web app's origin (for example a separate API domain).
  app.enableCors({ origin: config.get('FRONTEND_URL', { infer: true }), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  return app;
}
