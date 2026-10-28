import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiSuccess } from '@rms/shared';
import { Request, Response } from 'express';
import { map, Observable } from 'rxjs';
import { RESPONSE_MESSAGE } from './decorators';
import { Page } from './pagination';

/** Wraps every successful response in the fixed envelope. Handlers return plain data or a Page. */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector) {}

  intercept(ec: ExecutionContext, next: CallHandler): Observable<ApiSuccess<unknown>> {
    const req = ec.switchToHttp().getRequest<Request & { requestId: string }>();
    const res = ec.switchToHttp().getResponse<Response>();
    const message = this.reflector.get<string>(RESPONSE_MESSAGE, ec.getHandler())
      ?? (res.statusCode === 201 ? 'Created successfully' : 'Request successful');

    return next.handle().pipe(
      map((body) => {
        const paged = body instanceof Page;
        return {
          success: true as const,
          statusCode: res.statusCode,
          message,
          data: paged ? body.items : (body ?? null),
          ...(paged ? { meta: { pagination: body.pagination } } : {}),
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
          requestId: req.requestId,
        };
      }),
    );
  }
}
