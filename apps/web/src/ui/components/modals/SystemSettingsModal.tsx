/**
 * SystemSettingsModal Component
 *
 * Admin-only modal for system-level settings: user management, metrics.
 * Recovered from the archived system settings modal. The v2 sync server
 * exposes no admin user-management or metrics endpoints, so both tabs
 * render their structure with an honest "not available in this build" note
 * instead of the legacy live tables. No entry point mounts this yet — it is
 * recovered and exported for when an admin surface lands.
 */
import { useState } from "react";

import { Modal } from "../ui/Modal.js";
import { Separator } from "../ui/Separator.js";

import "./settingsModal.css";
import "./SystemSettingsModal.css";

interface SystemSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SystemTab = "users" | "metrics";

export function SystemSettingsModal({ isOpen, onClose }: SystemSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SystemTab>("users");

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="System Settings" size="lg">
      <div className="system-settings">
        <div className="system-settings__tabs">
          <button
            className={`system-settings__tab ${activeTab === "users" ? "active" : ""}`}
            onClick={() => setActiveTab("users")}
          >
            Users
          </button>
          <button
            className={`system-settings__tab ${activeTab === "metrics" ? "active" : ""}`}
            onClick={() => setActiveTab("metrics")}
          >
            Metrics
          </button>
        </div>

        <Separator />

        {activeTab === "users" && (
          <div className="system-settings__users">
            <div className="system-settings__users-header">
              <h3>User Management</h3>
            </div>
            <p className="system-settings__unavailable">
              User management is not available in this build.
            </p>
          </div>
        )}

        {activeTab === "metrics" && (
          <div className="system-settings__metrics">
            <h3>System Metrics</h3>
            <p className="system-settings__unavailable">
              System metrics are not available in this build.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
