/**
 * One-time frontend migration that fixes date pages whose stored text content
 * was appended instead of replaced by an earlier server-side migration.
 *
 * The migration runs once per workspace after the store client is ready. It
 * finds daily/monthly/yearly pages whose current plaintext is not the compact
 * numeric format, and calls setNodeText to replace it. This generates proper
 * Yjs textUpdate operations that sync through the normal operation log.
 */

import { useEffect, useRef } from 'react';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { nodeNameToText } from '@/features/queries';
import type { Node } from '@/types/api';

const MIGRATION_FLAG_KEY = 'notees_date_content_migration_v1';

function expectedDateContent(node: Node): string | null {
  if (node.is_daily) {
    const match = node.uuid.match(/^00000000-0000-0000-00dd-(\d{4})(\d{2})(\d{2})0000$/);
    if (match) return `${match[1]}${match[2]}${match[3]}`;
  }
  if (node.is_monthly) {
    const match = node.uuid.match(/^00000000-0000-0000-00aa-(\d{4})(\d{2})000000$/);
    if (match) return `${match[1]}${match[2]}00`;
  }
  if (node.is_yearly) {
    const match = node.uuid.match(/^00000000-0000-0000-00bb-(\d{4})00000000$/);
    if (match) return `${match[1]}0000`;
  }
  return null;
}

function needsFix(node: Node): string | null {
  const expected = expectedDateContent(node);
  if (!expected) return null;
  const current = nodeNameToText(node.name);
  return current !== expected ? expected : null;
}

function getMigratedWorkspaces(): Set<string> {
  try {
    const raw = localStorage.getItem(MIGRATION_FLAG_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function markWorkspaceMigrated(workspaceUuid: string): void {
  try {
    const migrated = getMigratedWorkspaces();
    migrated.add(workspaceUuid);
    localStorage.setItem(MIGRATION_FLAG_KEY, JSON.stringify(Array.from(migrated)));
  } catch {
    // ignore
  }
}

export function useDateContentMigration(enabled: boolean): void {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const ranRef = useRef(false);

  useEffect(() => {
    if (!enabled || !client || !workspaceUuid || ranRef.current) return;
    const migrated = getMigratedWorkspaces();
    if (migrated.has(workspaceUuid)) return;

    ranRef.current = true;

    const run = async (): Promise<void> => {
      try {
        const dateNodes = await client.query<Node[]>('queryNodes', [
          {
            classIds: [
              SYSTEM_CLASS_UUIDS.day,
              SYSTEM_CLASS_UUIDS.month,
              SYSTEM_CLASS_UUIDS.year,
            ],
            projectionDepth: 0,
          },
        ]);

        let fixed = 0;
        for (const node of dateNodes) {
          const expected = needsFix(node);
          if (!expected) continue;
          await client.mutate<void>('setNodeText', [node.uuid, expected]);
          fixed += 1;
        }

        if (fixed > 0) {
          console.log(`[useDateContentMigration] fixed ${fixed} date page(s)`);
        }
        markWorkspaceMigrated(workspaceUuid);
      } catch (err) {
        console.error('[useDateContentMigration] failed:', err);
      }
    };

    void run();
  }, [enabled, client, workspaceUuid]);
}
