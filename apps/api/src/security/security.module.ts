import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { config } from '../config';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';

/**
 * Per-IP rate limiting (default bucket; auth routes override with a stricter @Throttle) and the
 * idempotency interceptor. Imported FIRST in AppModule so the throttler runs before any auth work.
 */
@Global()
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: config.throttleDefaultPerMin }])],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }, IdempotencyInterceptor],
  exports: [IdempotencyInterceptor],
})
export class SecurityModule {}
