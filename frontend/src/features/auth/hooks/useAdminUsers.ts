/**
 * React Query hook for admin user list.
 */
import { useQuery } from '@tanstack/react-query';
import { listUsers } from '@/features/auth';
import { adminKeys } from '@/hooks/queryKeys';

export function useAdminUsers(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: adminKeys.users(),
    queryFn: () => listUsers(),
    enabled: options?.enabled ?? true,
    select: (data) => ({ users: data.items }),
  });
}
