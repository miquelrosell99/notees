/**
 * React Query mutations for admin user management.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createAdminUser, updateAdminUser, deactivateAdminUser } from '@/features/auth';
import { adminKeys } from '@/hooks/queryKeys';
import type { AdminUserUpdate } from '@/types';

export function useUserManagementMutations() {
  const queryClient = useQueryClient();

  const createUser = useMutation({
    mutationFn: createAdminUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.users() });
    },
  });

  const updateUser = useMutation({
    mutationFn: ({ userUuid, data }: { userUuid: string; data: AdminUserUpdate }) => updateAdminUser(userUuid, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.users() });
    },
  });

  const deactivateUser = useMutation({
    mutationFn: deactivateAdminUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.users() });
    },
  });

  return { createUser, updateUser, deactivateUser };
}
