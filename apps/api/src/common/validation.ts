import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { ValidationDetail } from '@rms/shared';
import { AppException } from './errors';

/** Flattens nested class-validator errors into [{ field: 'address.zipCode', rule, message }]. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): ValidationDetail[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.entries(e.constraints ?? {}).map(([rule, message]) => ({ field, rule, message }));
    return [...own, ...flattenValidationErrors(e.children ?? [], field)];
  });
}

export const validationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Validation failed', flattenValidationErrors(errors)),
  });
