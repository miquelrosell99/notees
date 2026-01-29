/**
 * Hook to get the Page system class
 * 
 * This is used when creating pages - instead of setting is_page=true,
 * we assign the Page class which causes is_page to be computed by the backend.
 */
import { useMemo } from 'react';
import { useClasses } from './useNodes';
import { SYSTEM_CLASS_UUIDS } from '@/constants';

/**
 * Get the Page class node and its ID
 * Returns null if classes haven't loaded yet
 */
export function usePageClass() {
  const { data: allClasses, isLoading } = useClasses();
  
  const pageClass = useMemo(() => {
    if (!allClasses) return null;
    return allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.page) ?? null;
  }, [allClasses]);
  
  return {
    pageClass,
    pageClassId: pageClass?.id ?? null,
    isLoading,
  };
}
