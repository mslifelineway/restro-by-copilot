import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ApiErrorBody } from '@rms/shared';
import { Request, Response } from 'express';

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 422: 'UNPROCESSABLE_ENTITY', 429: 'TOO_MANY_REQUESTS',
};

/** Converts every thrown error into the fixed error envelope. Unknown errors never leak internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private log = new Logger('Http');

  catch(err: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { requestId?: string }>();
    const res = http.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error: ApiErrorBody['error'] = { code: 'INTERNAL_ERROR', message: 'Internal server error' };

    if (err instanceof HttpException) {
      status = err.getStatus();
      const r = err.getResponse();
      const obj = typeof r === 'string' ? { message: r } : (r as Record<string, unknown>);
      error = {
        code: (obj.code as string) ?? DEFAULT_CODES[status] ?? 'ERROR',
        message: typeof obj.message === 'string' ? obj.message : Array.isArray(obj.message) ? obj.message.join('; ') : err.message,
        ...(obj.details ? { details: obj.details as ApiErrorBody['error']['details'] } : {}),
      };
    }

    if (status >= 500) {
      this.log.error(`[${req.requestId}] ${req.method} ${req.originalUrl} -> ${status}`, err instanceof Error ? err.stack : String(err));
    } else {
      this.log.warn(`[${req.requestId}] ${req.method} ${req.originalUrl} -> ${status} ${error.code}`);
    }

    const body: ApiErrorBody = {
      success: false, statusCode: status, error,
      timestamp: new Date().toISOString(), path: req.originalUrl, requestId: req.requestId ?? '',
    };
    res.status(status).json(body);
  }
}
