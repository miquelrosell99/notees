/**
 * UserSettingsModal Component
 *
 * The quick-tweaks modal: the theme segmented control, the accent picker,
 * and focus mode — the appearance changes worth reaching in one gesture
 * (the sidebar gear or Ctrl/Cmd+,). Everything else lives on the full
 * settings page at /settings/<section>, linked from the "Advanced settings"
 * row at the bottom.
 */
import { Modal } from "../ui/Modal.js";
import { Card } from "../ui/Card.js";
import { BooleanToggle } from "../ui/BooleanToggle.js";
import { Icon } from "../../Icon.js";
import { AccentColorPicker, ThemeModeControl } from "../SettingsPage.js";
import { applyAppearance, useDeviceSetting } from "./deviceSettings.js";

import "./settingsModal.css";
import "./UserSettingsModal.css";

export interface UserSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Open the full settings page (the App owns the route push). */
  onOpenAdvanced: () => void;
}

export function UserSettingsModal({ isOpen, onClose, onOpenAdvanced }: UserSettingsModalProps) {
  const [focusMode, setFocusMode] = useDeviceSetting("focusMode", false);

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="User Settings"
      size="lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
      contentClassName="settings-modal__body"
    >
      <div className="settings-modal__container">
        <div className="settings-modal__content">
          <div className="settings-section">
            <Card>
              <div className="settings-item">
                <div className="settings-item__info">
                  <label htmlFor="user-theme" className="settings-item__label">
                    Theme
                  </label>
                  <p className="settings-item__description">Choose your preferred color theme</p>
                </div>
                <ThemeModeControl id="user-theme" />
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label className="settings-item__label">Accent Color</label>
                  <p className="settings-item__description">
                    Functional accent for tags, badges, and active states
                  </p>
                </div>
                <AccentColorPicker />
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <label htmlFor="user-focus-mode" className="settings-item__label">
                    Focus mode
                  </label>
                  <p className="settings-item__description">
                    Only the editor stays bright — the rest of the interface dims and the
                    page chrome (backlinks, icons, properties) hides. Esc exits.
                  </p>
                </div>
                <BooleanToggle
                  id="user-focus-mode"
                  checked={focusMode}
                  onChange={(e) => {
                    setFocusMode(e.target.checked);
                    applyAppearance();
                  }}
                  size="md"
                />
              </div>

              <div className="settings-item">
                <div className="settings-item__info">
                  <span className="settings-item__label">Advanced settings</span>
                  <p className="settings-item__description">
                    Editor, general, sync, account, security, support, and about
                  </p>
                </div>
                <button
                  type="button"
                  className="settings-modal__advanced-link"
                  onClick={onOpenAdvanced}
                >
                  <span>Open</span>
                  <Icon path="mdi-arrow-right" size={0.8} />
                </button>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </Modal>
  );
}
