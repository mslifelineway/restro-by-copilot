import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { AnyMe } from './types';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<AnyMe>('/v1/auth/me'), staleTime: 60_000 });

/** Platform: support agents are read-only on the platform API; hide mutation controls for them (UX only). */
export function useCanWrite() {
  const me = useMe().data;
  return me?.kind === 'platform' && me.role === 'super_admin';
}

/** Tenant: does the signed-in user hold this permission? (UX only — the API enforces it.) */
export function useCan(permission: string) {
  const me = useMe().data;
  return me?.kind === 'tenant' && permission in me.permissions;
}
