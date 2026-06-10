/**
 * BlockPresenceOverlay — Renders colored presence indicators next to blocks
 * that remote users are currently editing.
 *
 * Uses fixed positioning relative to the viewport so it works regardless
 * of scroll containers or virtualization state.
 */

import { useEffect, useState } from 'react';
import { useLivePresenceStore, type PresenceUser } from '@/stores/livePresenceStore';
import './BlockPresenceOverlay.css';

interface PositionedBlock {
  blockUuid: string;
  users: PresenceUser[];
  left: number;
  top: number;
}

interface BlockPresenceOverlayProps {
  nodeUuid: string;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function BlockPresenceOverlay({ nodeUuid }: BlockPresenceOverlayProps) {
  const presence = useLivePresenceStore((s) => s.presence[nodeUuid]);
  const [positions, setPositions] = useState<PositionedBlock[]>([]);

  useEffect(() => {
    function updatePositions() {
      const next: PositionedBlock[] = [];
      for (const [blockUuid, users] of Object.entries(presence ?? {})) {
        if (!users || users.length === 0) continue;
        const blockEl = document.querySelector(
          `.node-block[data-block-id="${blockUuid}"]`,
        ) as HTMLElement | null;
        if (!blockEl) continue;
        const bullet = blockEl.querySelector('.bullet-wrapper') as HTMLElement | null;
        const target = bullet ?? blockEl;
        const rect = target.getBoundingClientRect();
        if (
          rect.bottom < 0 ||
          rect.top > window.innerHeight ||
          rect.right < 0 ||
          rect.left > window.innerWidth
        ) {
          continue;
        }
        next.push({
          blockUuid,
          users,
          left: rect.left - 18,
          top: rect.top + rect.height / 2 - 8,
        });
      }
      setPositions(next);
    }

    updatePositions();
    window.addEventListener('scroll', updatePositions, true);
    window.addEventListener('resize', updatePositions);
    const interval = setInterval(updatePositions, 750);

    return () => {
      window.removeEventListener('scroll', updatePositions, true);
      window.removeEventListener('resize', updatePositions);
      clearInterval(interval);
    };
  }, [presence]);

  if (positions.length === 0) return null;

  return (
    <div className="block-presence-overlay" aria-hidden="true">
      {positions.map(({ blockUuid, users, left, top }) => (
        <div
          key={blockUuid}
          className="block-presence-indicator"
          style={{
            position: 'fixed',
            left,
            top,
            zIndex: 50,
            display: 'flex',
            gap: '2px',
            pointerEvents: 'none',
          }}
          title={users.map((u) => `${u.name} is editing`).join(', ')}
        >
          {users.map((u, idx) => (
            <div
              key={u.id}
              className="block-presence-dot"
              style={{
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                backgroundColor: u.color,
                border: '2px solid var(--surface-1, #fff)',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '9px',
                fontWeight: 700,
                color: '#fff',
                textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                marginLeft: idx > 0 ? '-4px' : '0',
                animation: 'presence-dot-in 0.2s ease-out',
              }}
            >
              {getInitials(u.name)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
