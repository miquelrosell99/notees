/**
 * SupportBadge component
 *
 * A small, dismissible sidebar card asking users to support Notees.
 * No features are gated; hiding the badge only removes the UI reminder.
 */
import { useState } from 'react';
import { useSettingsStore, isSupportBadgeVisible } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PRIMARY_SPONSORSHIP_CHANNEL } from '@/constants/sponsorship';
import './SupportBadge.css';

interface SupportBadgeProps {
  /** Render a compact variant suitable for the collapsed sidebar. */
  compact?: boolean;
  className?: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function SupportBadge({ compact = false, className = '' }: SupportBadgeProps) {
  const supportBadgeHidden = useSettingsStore((s) => s.supportBadgeHidden);
  const supportBadgeHiddenUntil = useSettingsStore((s) => s.supportBadgeHiddenUntil);
  const setSupportBadgeHidden = useSettingsStore((s) => s.setSupportBadgeHidden);
  const setSupportBadgeHiddenUntil = useSettingsStore((s) => s.setSupportBadgeHiddenUntil);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  if (!isSupportBadgeVisible(supportBadgeHidden, supportBadgeHiddenUntil)) {
    return null;
  }

  const handleOpenConfirm = () => {
    setShowConfirmModal(true);
  };

  const handleCloseConfirm = () => {
    setShowConfirmModal(false);
  };

  const handleHideForever = () => {
    setSupportBadgeHiddenUntil(null);
    setSupportBadgeHidden(true);
    setShowConfirmModal(false);
  };

  const handleHideThirtyDays = () => {
    setSupportBadgeHidden(false);
    setSupportBadgeHiddenUntil(Date.now() + THIRTY_DAYS_MS);
    setShowConfirmModal(false);
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
    <>
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
            onClick={handleOpenConfirm}
            aria-label="Hide support badge"
            title="Hide"
          />
        </div>
      </div>

      <Modal
        isOpen={showConfirmModal}
        onClose={handleCloseConfirm}
        title="Support Notees"
        size="sm"
        showCloseButton={false}
        closeOnBackdrop
        closeOnEscape
        footer={
          <div className="support-badge__confirm-footer">
            <Button variant="ghost" onClick={handleCloseConfirm}>
              Cancel
            </Button>
            <Button variant="default" onClick={handleHideThirtyDays}>
              Remind me in 30 days
            </Button>
            <Button variant="primary" onClick={handleHideForever}>
              Hide forever
            </Button>
          </div>
        }
      >
        <p className="support-badge__confirm-text">
          Notees is funded by people like you. If you hide this reminder, you can
          always support the project later from Settings → Support.
        </p>
      </Modal>
    </>
  );
}
