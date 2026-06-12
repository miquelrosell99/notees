/**
 * PublicShareView — Read-only view of a publicly shared node.
 *
 * Works without authentication. Fetches node data via public API.
 */
import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Spinner } from '@/components/ui/Spinner';
import { Icon } from '@/components/ui/Icon';
import { getPublicSharedNode } from '@/features/shares/api/shares';
import { NodeInline } from '@/features/content/components/blocks/NodeInline';
import { getPropertyValueRenderer } from '@/features/content/components/properties/propertyValueRegistry';
import '@/features/content/components/properties/registerPropertyRenderers';
import type { PublicSharedNode } from '@/features/shares/api/shares';
import './PublicShareView.css';

/**
 * Render a property value for public display (read-only, no auth required).
 */
function PublicPropertyValue({
  propertyDef,
  value,
  childrenBlocks,
}: {
  propertyDef: PublicSharedNode['property_definitions'][number];
  value: unknown;
  childrenBlocks: PublicSharedNode['children'];
}) {
  // Multi-value: render each value
  if (propertyDef.multi && Array.isArray(value)) {
    if (value.length === 0) return <span className="public-share-view__prop-value--empty">—</span>;
    return (
      <span className="public-share-view__prop-value--multi">
        {value.map((v, i) => (
          <span key={i} className="public-share-view__prop-value--tag">
            <PublicPropertyValue propertyDef={propertyDef} value={v} childrenBlocks={childrenBlocks} />
          </span>
        ))}
      </span>
    );
  }

  // Use registry formatter for simple types; keep custom logic for URL/email/text
  const renderer = getPropertyValueRenderer(propertyDef.type);
  if (renderer && propertyDef.type !== 'url' && propertyDef.type !== 'email' && propertyDef.type !== 'text') {
    const formatted = renderer.formatValue(value);
    if (formatted) return <span>{formatted}</span>;
  }

  switch (propertyDef.type) {
    case 'url':
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" className="public-share-view__prop-link">
          {String(value)}
        </a>
      );

    case 'email':
      return (
        <a href={`mailto:${String(value)}`} className="public-share-view__prop-link">
          {String(value)}
        </a>
      );

    case 'selection': {
      const option = propertyDef.options.find((o) => o.id === value);
      if (!option) return <span>{String(value)}</span>;
      return (
        <span className="public-share-view__prop-value--selection">
          {option.color && (
            <span className="public-share-view__prop-dot" style={{ background: option.color }} />
          )}
          {option.name}
        </span>
      );
    }

    case 'text': {
      // Text properties reference a block node — look it up in children
      const blockId = typeof value === 'number' ? value : null;
      if (blockId) {
        const block = childrenBlocks.find((c) => c.id === blockId);
        if (block) {
          return (
            <NodeInline
              name={block.name}
              displayText={block.display_name}
              icon={block.icon}
              isPage={block.is_page}
              nodeId={block.id}
              showBullet={false}
              suppressColor={false}
            />
          );
        }
      }
      return <span>Text content</span>;
    }

    case 'node':
    case 'date':
    case 'image':
    default:
      return <span>{String(value ?? '—')}</span>;
  }
}

/**
 * Read-only properties section for public share view.
 */
function PublicPropertiesSection({
  propertyDefinitions,
  properties,
  childrenBlocks,
}: {
  propertyDefinitions: PublicSharedNode['property_definitions'];
  properties: Record<string, unknown>;
  childrenBlocks: PublicSharedNode['children'];
}) {
  const entries = useMemo(() => {
    return Object.entries(properties)
      .map(([propIdStr, value]) => {
        const propDef = propertyDefinitions.find((p) => String(p.id) === propIdStr);
        if (!propDef) return null;
        return { propDef, value };
      })
      .filter(Boolean) as Array<{ propDef: PublicSharedNode['property_definitions'][number]; value: unknown }>;
  }, [properties, propertyDefinitions]);

  if (entries.length === 0) return null;

  return (
    <div className="public-share-view__properties">
      <h3 className="public-share-view__properties-title">Properties</h3>
      <div className="public-share-view__properties-list">
        {entries.map(({ propDef, value }) => (
          <div key={propDef.id} className="public-share-view__property-row">
            <span className="public-share-view__property-name">
              {propDef.icon && (
                <Icon path={propDef.icon} className="public-share-view__property-icon" />
              )}
              {propDef.name}
            </span>
            <span className="public-share-view__property-value">
              <PublicPropertyValue propertyDef={propDef} value={value} childrenBlocks={childrenBlocks} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PublicShareView() {
  const [data, setData] = useState<PublicSharedNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { shareUuid } = useParams<{ shareUuid: string }>();
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const uuid = shareUuid;
      if (!uuid) {
        if (!cancelled) {
          setError('Invalid share link');
          setLoading(false);
        }
        return;
      }
      try {
        const res = await getPublicSharedNode(uuid);
        if (!cancelled) {
          setData(res);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const detail =
            (err as { response?: { data?: { detail?: string } } })?.response?.data
              ?.detail || 'Share not found or expired';
          if (detail === 'password_required') {
            setNeedsPassword(true);
          } else {
            setError(detail);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [shareUuid]);

  const handleSubmitPassword = async () => {
    if (!shareUuid || !password) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getPublicSharedNode(shareUuid, password);
      setData(res);
      setNeedsPassword(false);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || 'Incorrect password';
      setError(detail === 'password_required' ? 'Incorrect password' : detail);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="public-share-view public-share-view--centered">
        <Spinner size="lg" label="Loading shared page..." centered />
      </div>
    );
  }

  if (needsPassword) {
    return (
      <div className="public-share-view public-share-view--centered">
        <div className="public-share-view__password-gate">
          <h1>Password protected</h1>
          <p>This shared page requires a password to view.</p>
          <div className="public-share-view__password-row">
            <input
              type="password"
              className="public-share-view__password-input"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitPassword(); }}
            />
            <button
              className="public-share-view__password-btn"
              onClick={handleSubmitPassword}
            >
              Unlock
            </button>
          </div>
          {error && <p className="public-share-view__password-error">{error}</p>}
        </div>
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
          displayText={data.node.display_name}
          icon={data.node.icon}
          isPage={data.node.is_page}
          nodeId={data.node.id}
          showBullet={false}
          suppressColor={false}
        />
      </div>

      {/* Properties Section */}
      {data.property_definitions.length > 0 && (
        <PublicPropertiesSection
          propertyDefinitions={data.property_definitions}
          properties={data.node.properties}
          childrenBlocks={data.children}
        />
      )}

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
                displayText={child.display_name}
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
