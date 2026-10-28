import type { ApiErrorBody, ApiSuccess, Pagination } from '@rms/shared';

/** Typed error carrying the backend's error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorBody['error']['details'],
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiSuccess<T>> {
  const res = await fetch(`/api/bff${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) location.assign('/login');
    const e = (body as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'UNKNOWN_ERROR', e?.message ?? 'Unexpected error', e?.details, body?.requestId);
  }
  return body as ApiSuccess<T>;
}

const json = (b: unknown) => JSON.stringify(b);

export const api = {
  get: async <T>(p: string) => (await request<T>(p)).data,
  post: async <T>(p: string, b: unknown) => (await request<T>(p, { method: 'POST', body: json(b) })).data,
  put: async <T>(p: string, b: unknown) => (await request<T>(p, { method: 'PUT', body: json(b) })).data,
  patch: async <T>(p: string, b: unknown) => (await request<T>(p, { method: 'PATCH', body: json(b) })).data,
  delete: async <T>(p: string) => (await request<T>(p, { method: 'DELETE' })).data,
  /** For paginated endpoints: returns rows plus meta.pagination. */
  list: async <T>(p: string): Promise<{ items: T[]; pagination: Pagination }> => {
    const r = await request<T[]>(p);
    return { items: r.data, pagination: r.meta!.pagination! };
  },
};

/** Maps backend VALIDATION_FAILED details onto react-hook-form fields. */
export function applyServerErrors(
  e: unknown,
  setError: (name: never, err: { message: string }) => void,
): string | null {
  if (!(e instanceof ApiError)) return 'Something went wrong';
  if (e.code === 'VALIDATION_FAILED' && Array.isArray(e.details)) {
    e.details.forEach((d) => setError(d.field as never, { message: d.message }));
    return null;
  }
  return e.message;
}
