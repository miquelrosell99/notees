/**
 * Hooks to get system classes
 * 
 * These are used when creating nodes with specific system classes.
 * Instead of setting flags like is_page=true, is_class=true, etc.,
 * we assign the appropriate class which causes the flags to be computed by the backend.
 */
import { useMemo } from 'react';
import { useClasses } from './useNodeQueries';
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
    pageClassUuid: pageClass?.uuid ?? null,
    isLoading,
  };
}

/**
 * Get the Class class node and its ID (for creating new class definitions)
 */
export function useClassClass() {
  const { data: allClasses, isLoading } = useClasses();
  
  const classClass = useMemo(() => {
    if (!allClasses) return null;
    return allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.class) ?? null;
  }, [allClasses]);
  
  return {
    classClass,
    classClassUuid: classClass?.uuid ?? null,
    isLoading,
  };
}

/**
 * Get all system classes at once (for components that need multiple)
 * Returns an object with classId for each system class
 */
export function useSystemClasses() {
  const { data: allClasses, isLoading } = useClasses();
  
  const systemClasses = useMemo(() => {
    if (!allClasses) return null;
    
    return {
      page: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.page) ?? null,
      class: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.class) ?? null,
      day: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.day) ?? null,
      month: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.month) ?? null,
      year: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.year) ?? null,
      comment: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.comment) ?? null,
      task: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.task) ?? null,
      template: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.template) ?? null,
      asset: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.asset) ?? null,
      quote: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.quote) ?? null,
      query: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.query) ?? null,
      code: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.code) ?? null,
      whiteboard: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.whiteboard) ?? null,
      card: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.card) ?? null,
      cloze: allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.cloze) ?? null,
    };
  }, [allClasses]);
  
  const systemClassUuids = useMemo(() => {
    if (!systemClasses) return null;

    return {
      page: systemClasses.page?.uuid ?? null,
      class: systemClasses.class?.uuid ?? null,
      day: systemClasses.day?.uuid ?? null,
      month: systemClasses.month?.uuid ?? null,
      year: systemClasses.year?.uuid ?? null,
      comment: systemClasses.comment?.uuid ?? null,
      task: systemClasses.task?.uuid ?? null,
      template: systemClasses.template?.uuid ?? null,
      asset: systemClasses.asset?.uuid ?? null,
      quote: systemClasses.quote?.uuid ?? null,
      query: systemClasses.query?.uuid ?? null,
      code: systemClasses.code?.uuid ?? null,
      whiteboard: systemClasses.whiteboard?.uuid ?? null,
      card: systemClasses.card?.uuid ?? null,
      cloze: systemClasses.cloze?.uuid ?? null,
    };
  }, [systemClasses]);

  return {
    systemClasses,
    systemClassUuids,
    isLoading,
  };
}
