/**
 * Hooks to get system classes
 *
 * These are used when creating nodes with specific system classes.
 */
import { useMemo } from 'react';
import { useClasses } from '@/core/hooks';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import type { ClassRow } from '@/core/query/classes';

function findClassByUuid(classes: ClassRow[] | undefined, uuid: string): ClassRow | null {
  return classes?.find((c) => c.id === uuid) ?? null;
}

/**
 * Get the Class class row and its ID (for creating new class definitions)
 */
export function useClassClass() {
  const { data: allClasses, isLoading } = useClasses();

  const classClass = useMemo(() => {
    return findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.class);
  }, [allClasses]);

  return {
    classClass,
    classClassUuid: classClass?.id ?? null,
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
      class: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.class),
      day: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.day),
      month: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.month),
      year: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.year),
      comment: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.comment),
      task: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.task),
      template: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.template),
      asset: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.asset),
      quote: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.quote),
      query: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.query),
      code: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.code),
      whiteboard: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.whiteboard),
      card: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.card),
      cloze: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.cloze),
      source: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.source),
      agent: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.agent),
      collection: findClassByUuid(allClasses, SYSTEM_CLASS_UUIDS.collection),
    };
  }, [allClasses]);

  const systemClassUuids = useMemo(() => {
    if (!systemClasses) return null;

    return {
      class: systemClasses.class?.id ?? null,
      day: systemClasses.day?.id ?? null,
      month: systemClasses.month?.id ?? null,
      year: systemClasses.year?.id ?? null,
      comment: systemClasses.comment?.id ?? null,
      task: systemClasses.task?.id ?? null,
      template: systemClasses.template?.id ?? null,
      asset: systemClasses.asset?.id ?? null,
      quote: systemClasses.quote?.id ?? null,
      query: systemClasses.query?.id ?? null,
      code: systemClasses.code?.id ?? null,
      whiteboard: systemClasses.whiteboard?.id ?? null,
      card: systemClasses.card?.id ?? null,
      cloze: systemClasses.cloze?.id ?? null,
      source: systemClasses.source?.id ?? null,
      agent: systemClasses.agent?.id ?? null,
      collection: systemClasses.collection?.id ?? null,
    };
  }, [systemClasses]);

  return {
    systemClasses,
    systemClassUuids,
    isLoading,
  };
}
