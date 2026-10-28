export function drizzlePgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') return cause.code;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}
