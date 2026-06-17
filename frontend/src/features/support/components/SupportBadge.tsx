/**
 * SupportBadge component
 *
 * A small, dismissible sidebar card asking users to support Notees.
 * No features are gated; hiding the badge only removes the UI reminder.
 */
import { useSettingsStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { PRIMARY_SPONSORSHIP_CHANNEL } from '@/constants/sponsorship';
import './SupportBadge.css';

interface SupportBadgeProps {
  /** Render a compact variant suitable for the collapsed sidebar. */
  compact?: boolean;
  className?: string;
}

export function SupportBadge({ compact = false, className = '' }: SupportBadgeProps) {
  const supportBadgeHidden = useSettingsStore((s) => s.supportBadgeHidden);
  const setSupportBadgeHidden = useSettingsStore((s) => s.setSupportBadgeHidden);

  if (supportBadgeHidden) {
    return null;
  }

  const handleHide = () => {
    setSupportBadgeHidden(true);
  };

  if (compact) {
    return (
      <a
        href={PRIMARY_SPONSORSHIP_CHANNEL.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`support-badge support-badge--compact ${className}`}
        aria-label="Support Notees"
        title="Support Notees"
      >
        <span className="support-badge__icon mdi mdi-heart" aria-hidden="true" />
      </a>
    );
  }

  return (
    <div className={`support-badge ${className}`}>
      <div className="support-badge__content">
        <span className="support-badge__icon mdi mdi-heart" aria-hidden="true" />
        <span className="support-badge__text">Support Notees</span>
      </div>
      <div className="support-badge__actions">
        <a
          href={PRIMARY_SPONSORSHIP_CHANNEL.url}
          target="_blank"
          rel="noopener noreferrer"
          className="support-badge__link"
        >
          Sponsor
        </a>
        <Button
          variant="ghost"
          size="xs"
          icon="mdi mdi-close"
          onClick={handleHide}
          aria-label="Hide support badge"
          title="Hide forever"
        />
      </div>
    </div>
  );
}
