/**
 * PublicShareView — Read-only view of a publicly shared node.
 *
 * Works without authentication. Fetches node data via public API.
 */
import { useState, useEffect } from 'react';
import { Spinner } from '@/components/core/Spinner';
import { getPublicSharedNode } from '@/api/shares';
import { NodeInline } from '@/components/blocks/NodeInline';
import './PublicShareView.css';

export function PublicShareView() {
  const [data, setData] = useState<{
    node: { id: number; uuid: string; name: string; icon: string | null; color: string | null; is_page: boolean };
    children: { id: number; uuid: string; name: string; icon: string | null; color: string | null; is_page: boolean; depth: number }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const shareUuid = window.location.pathname.split('/').pop();
      if (!shareUuid) {
        if (!cancelled) {
          setError('Invalid share link');
          setLoading(false);
        }
        return;
      }
      try {
        const res = await getPublicSharedNode(shareUuid);
        if (!cancelled) {
          setData(res);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const detail =
            (err as { response?: { data?: { detail?: string } } })?.response?.data
              ?.detail || 'Share not found or expired';
          setError(detail);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="public-share-view public-share-view--centered">
        <Spinner size="lg" label="Loading shared page..." centered />
      </div>
    );
  }

  if (error) {
    return (
      <div className="public-share-view public-share-view--centered">
        <div className="public-share-view__error">
          <h1>Share not available</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="public-share-view">
      <div className="public-share-view__header">
        <div className="public-share-view__badge">Shared publicly</div>
        <NodeInline
          name={data.node.name}
          icon={data.node.icon}
          isPage={data.node.is_page}
          nodeId={data.node.id}
          showBullet={false}
          suppressColor={false}
        />
      </div>
      <div className="public-share-view__content">
        {data.children.length === 0 ? (
          <p className="public-share-view__empty">This page has no content.</p>
        ) : (
          data.children.map((child) => (
            <div
              key={child.id}
              className="public-share-view__block"
              style={{ paddingLeft: `${child.depth * 1.5}rem` }}
            >
              <NodeInline
                name={child.name}
                icon={child.icon}
                isPage={child.is_page}
                nodeId={child.id}
                showBullet={true}
                suppressColor={false}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
