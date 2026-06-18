/**
 * React Query hooks for publicly shared nodes.
 */
import { useQuery, useMutation } from '@tanstack/react-query';
import { sharesKeys } from '@/hooks/queryKeys';
import { getPublicSharedNode } from '../api/shares';
import type { PublicSharedNode } from '../api/shares';

export function usePublicShare(shareUuid: string | undefined) {
  return useQuery<PublicSharedNode, Error>({
    queryKey: sharesKeys.public(shareUuid ?? ''),
    queryFn: () => getPublicSharedNode(shareUuid!),
    enabled: !!shareUuid,
    retry: false,
  });
}

export function useSubmitPublicSharePassword() {
  return useMutation<PublicSharedNode, Error, { shareUuid: string; password: string }>({
    mutationFn: ({ shareUuid, password }) => getPublicSharedNode(shareUuid, password),
  });
}
