import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Throw this for every expected failure. `code` is a stable SCREAMING_SNAKE machine code that
 * clients switch on (e.g. USER_NOT_FOUND); `message` is human readable; `details` is optional context.
 */
export class AppException extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: unknown) {
    super({ code, message, details }, status);
  }
}
