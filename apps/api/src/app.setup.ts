import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import helmet from 'helmet';
import { config } from './config';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { requestId } from './common/request-id';
import { ResponseInterceptor } from './common/response.interceptor';
import { validationPipe } from './common/validation';

/** Shared by main.ts and e2e tests so both run the same pipeline. */
export function configureApp(app: INestApplication) {
  app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.use(requestId);
  app.useGlobalPipes(validationPipe());
  // Order = outermost first: the envelope wraps whatever idempotency replays or stores.
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)), app.get(IdempotencyInterceptor));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}
