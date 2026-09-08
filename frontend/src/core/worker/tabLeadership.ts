/**
 * Tab leadership election for multi-tab workspace safety.
 *
 * The invariant: one SyncEngine / one SQLite writer per (workspace, actor)
 * per browser origin. Tabs elect a leader via the Web Locks API; the leader
 * hosts the real worker-backed store client (and its sync engine), follower
 * tabs proxy to it over BroadcastChannel (see tabRpc.ts).
 *
 * When the leader tab closes, its lock is released and a queued follower's
 * lock request is granted — that tab takes over by reloading, which re-runs
 * the normal open path against the latest IndexedDB bytes. Browsers without
 * Web Locks fall back to "every tab leads" (the pre-multi-tab behavior).
 */

import { getLogger } from '@/utils/logger';

const log = getLogger('tabLeadership');

export type TabRole = 'leader' | 'follower';

export interface TabElection {
  role: TabRole;
  /** Release leadership (leader only); the lock is also released on tab close. */
  release: () => void;
}

interface LockLike {
  mode: string;
  name: string;
}

interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: LockLike | null) => unknown
  ): Promise<unknown>;
}

function getLocks(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as { locks?: LockManagerLike }).locks;
}

function lockName(workspaceId: string, actorId: string): string {
  return `notees:workspace-tab:${workspaceId}:${actorId}`;
}

/**
 * Elect this tab's role for a workspace.
 *
 * `onTakeover` fires if this tab (previously a follower) is granted the lock
 * after the leader released it — the caller should reload or re-initialize,
 * because the tab is now the leader with a client built for following.
 */
export async function electWorkspaceTab(
  workspaceId: string,
  actorId: string,
  onTakeover: () => void
): Promise<TabElection> {
  const locks = getLocks();
  if (!locks) {
    // No Web Locks (jsdom, very old browsers): every tab leads, which is the
    // historical behavior — not multi-tab safe, but no worse than before.
    return { role: 'leader', release: () => {} };
  }

  const name = lockName(workspaceId, actorId);

  // Attempt immediate leadership. The callback always fires asynchronously —
  // with null when another tab holds the lock (ifAvailable), or with the lock
  // when granted — so resolve the outcome from inside it.
  let releaseLeader: () => void = () => {};
  const outcome = await new Promise<TabRole>((resolve) => {
    const request = locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve('follower');
        return null;
      }
      resolve('leader');
      // Hold the lock until release() (or tab close, which releases it
      // implicitly); the request promise settles then.
      return new Promise<void>((res) => {
        releaseLeader = res;
      });
    });
    void request.catch((err) => log.warn('leader lock request failed', { error: String(err) }));
  });

  if (outcome === 'leader') {
    log.info('Tab is workspace leader', { workspaceId });
    return {
      role: 'leader',
      release: () => releaseLeader(),
    };
  }

  // Follower: queue for the lock; when the leader's tab closes the request is
  // granted and this tab takes over.
  log.info('Tab is workspace follower', { workspaceId });
  const takeoverRequest = locks.request(name, { mode: 'exclusive' }, (lock) => {
    if (!lock) return null;
    log.info('Tab taking over workspace leadership', { workspaceId });
    onTakeover();
    // Hold until the tab closes; nothing to release voluntarily here.
    return new Promise<void>(() => {});
  });
  void takeoverRequest.catch((err) => log.warn('follower lock request failed', { error: String(err) }));

  return { role: 'follower', release: () => {} };
}
