/** Fixed backend response contract. Every API response (except file downloads) uses these shapes. */
export interface Pagination {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

interface Envelope {
  statusCode: number;
  timestamp: string;
  path: string;
  requestId: string;
}

export interface ApiSuccess<T> extends Envelope {
  success: true;
  message: string;
  data: T;
  meta?: { pagination?: Pagination };
}

export interface ValidationDetail {
  field: string;
  rule: string;
  message: string;
}

export interface ApiErrorBody extends Envelope {
  success: false;
  error: {
    code: string;
    message: string;
    /** Validation failures: ValidationDetail[]. Domain errors may carry an object (e.g. { feature }). */
    details?: ValidationDetail[] | Record<string, unknown>;
  };
}

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;
