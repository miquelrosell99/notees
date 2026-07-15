/**
 * SystemSettingsModal Component
 *
 * Admin-only modal for system-level settings: user management, metrics.
 */
import { useState, useRef, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Dropdown } from '@/components/ui/Dropdown';
import { BooleanToggle, Icon, Separator } from '@/components/ui';
import { useAuthStore } from '@/stores';
import { useClickOutside } from '@/hooks/useClickOutside';
import {
  useAdminUsers,
  useSystemMetrics,
  useUserManagementMutations,
} from '@/features/auth';
import type { AdminUserCreate } from '@/types';

import './SystemSettingsModal.css';

interface SystemSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SystemTab = 'users' | 'metrics';

const ROLE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Admin' },
];

function RowActionsMenu({
  userEmail,
  canDelete,
  onDelete,
  isDeleting,
}: {
  userEmail: string;
  canDelete: boolean;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useClickOutside([menuRef, buttonRef], () => setIsOpen(false), isOpen);

  const handleDelete = useCallback(() => {
    setIsOpen(false);
    setShowDeleteConfirm(true);
  }, []);

  return (
    <div className="system-settings__actions-menu-wrapper">
      <Button aria-label="Actions"
        ref={buttonRef}
        variant="ghost"
        size="xs"
        icon="mdi mdi-dots-vertical"
        onClick={() => setIsOpen(!isOpen)}
        disabled={isDeleting}
        title="Actions"
      />
      {isOpen && (
        <div ref={menuRef} className="system-settings__actions-menu">
          <button
            className="system-settings__actions-menu-item system-settings__actions-menu-item--danger"
            onClick={handleDelete}
            disabled={!canDelete}
          >
            <Icon path="mdi-trash-can" />
            Delete
          </button>
        </div>
      )}
      <ConfirmationModal
        isOpen={showDeleteConfirm}
        title="Delete User"
        message={`Delete ${userEmail}?`}
        secondaryMessage="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          onDelete();
          setShowDeleteConfirm(false);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}

export function SystemSettingsModal({ isOpen, onClose }: SystemSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SystemTab>('users');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const currentUser = useAuthStore((s) => s.user);

  const { data: usersData, isLoading: usersLoading } = useAdminUsers({ enabled: isOpen });
  const { data: metricsData } = useSystemMetrics({ enabled: isOpen && activeTab === 'metrics' });

  const {
    createUser: createUserMutation,
    updateUser: updateUserMutation,
    deactivateUser: deactivateUserMutation,
  } = useUserManagementMutations();

  const [newUser, setNewUser] = useState<AdminUserCreate>({
    email: '',
    password: '',
    name: '',
    role: 'user',
  });

  const adminCount = usersData?.users.filter((u) => u.role === 'admin' && u.active).length ?? 0;

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    createUserMutation.mutate(newUser, {
      onSuccess: () => {
        setShowCreateModal(false);
        setNewUser({ email: '', password: '', name: '', role: 'user' });
      },
    });
  };

  const handleRoleChange = (userUuid: string, newRole: string | null) => {
    if (!newRole) return;
    updateUserMutation.mutate({ userUuid, data: { role: newRole } });
  };

  const handleActiveChange = (userUuid: string, active: boolean) => {
    updateUserMutation.mutate({ userUuid, data: { active } });
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="System Settings" size="lg">
      <div className="system-settings">
        <div className="system-settings__tabs">
          <button
            className={`system-settings__tab ${activeTab === 'users' ? 'active' : ''}`}
            onClick={() => setActiveTab('users')}
          >
            Users
          </button>
          <button
            className={`system-settings__tab ${activeTab === 'metrics' ? 'active' : ''}`}
            onClick={() => setActiveTab('metrics')}
          >
            Metrics
          </button>
        </div>

        <Separator />

        {activeTab === 'users' && (
          <div className="system-settings__users">
            <div className="system-settings__users-header">
              <h3>User Management</h3>
              <Button
                variant="primary"
                size="sm"
                icon="mdi mdi-plus"
                onClick={() => setShowCreateModal(true)}
              >
                Add User
              </Button>
            </div>

            {usersLoading ? (
              <div className="system-settings__loading"><Spinner size="sm" label="Loading users..." /></div>
            ) : (
              <div className="system-settings__table">
                <div className="system-settings__table-header">
                  <span>Email</span>
                  <span>Name</span>
                  <span>Role</span>
                  <span>Active</span>
                  <span aria-hidden="true" />
                </div>
                {usersData?.users.map((user) => {
                  const isSelf = String(user.id) === String(currentUser?.nodeUuid);
                  const isLastAdmin = user.role === 'admin' && adminCount <= 1;
                  const canChangeRole = !(isSelf && user.role === 'admin') && !isLastAdmin;
                  const canDeactivate = !(isSelf || isLastAdmin);

                  return (
                    <div key={user.id} className="system-settings__table-row">
                      <span className="system-settings__cell-email">{user.email}</span>
                      <span className="system-settings__cell-name">{user.name || '—'}</span>
                      <span className="system-settings__cell-role">
                        <Dropdown
                          options={ROLE_OPTIONS}
                          value={user.role}
                          onChange={(val) => handleRoleChange(user.id, val)}
                          disabled={!canChangeRole}
                          size="sm"
                        />
                      </span>
                      <span className="system-settings__cell-active">
                        <BooleanToggle
                          checked={user.active}
                          onChange={() => handleActiveChange(user.id, !user.active)}
                          disabled={!canDeactivate}
                          size="sm"
                        />
                      </span>
                      <span className="system-settings__cell-actions">
                        <RowActionsMenu
                          userEmail={user.email}
                          canDelete={canDeactivate}
                          onDelete={() => deactivateUserMutation.mutate(user.id)}
                          isDeleting={deactivateUserMutation.isPending}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'metrics' && (
          <div className="system-settings__metrics">
            <h3>System Metrics</h3>
            {metricsData ? (
              <div className="system-settings__metrics-grid">
                <div className="system-settings__metric-card">
                  <span className="system-settings__metric-value">{metricsData.nodes.total}</span>
                  <span className="system-settings__metric-label">Total Nodes</span>
                </div>
                <div className="system-settings__metric-card">
                  <span className="system-settings__metric-value">{metricsData.nodes.pages}</span>
                  <span className="system-settings__metric-label">Pages</span>
                </div>
                <div className="system-settings__metric-card">
                  <span className="system-settings__metric-value">{metricsData.nodes.blocks}</span>
                  <span className="system-settings__metric-label">Blocks</span>
                </div>
                <div className="system-settings__metric-card">
                  <span className="system-settings__metric-value">{metricsData.nodes.daily_journals}</span>
                  <span className="system-settings__metric-label">Daily Journals</span>
                </div>
                <div className="system-settings__metric-card">
                  <span className="system-settings__metric-value">{metricsData.users}</span>
                  <span className="system-settings__metric-label">Users</span>
                </div>
                <div className="system-settings__metric-card">
                  <span className="system-settings__metric-value">{metricsData.workspaces}</span>
                  <span className="system-settings__metric-label">Workspaces</span>
                </div>
                <div className="system-settings__metric-card">
                  <span className="system-settings__metric-value">{metricsData.shares.public}</span>
                  <span className="system-settings__metric-label">Public Shares</span>
                </div>
                <div className="system-settings__metric-card">
                  <span className="system-settings__metric-value">{formatBytes(metricsData.storage_used)}</span>
                  <span className="system-settings__metric-label">Storage Used</span>
                </div>
              </div>
            ) : (
              <div className="system-settings__loading"><Spinner size="sm" label="Loading metrics..." /></div>
            )}
          </div>
        )}
      </div>

      {/* Create User Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Add User"
        size="md"
      >
        <form onSubmit={handleCreateUser} className="system-settings__create-form">
          <TextField
            label="Email"
            type="email"
            value={newUser.email}
            onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
            required
          />
          <TextField
            label="Password"
            type="password"
            value={newUser.password}
            onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            required
          />
          <TextField
            label="Name"
            value={newUser.name}
            onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
          />
          <div className="system-settings__field">
            <label htmlFor="system-user-role" className="system-settings__field-label">Role</label>
            <Dropdown
              id="system-user-role"
              options={ROLE_OPTIONS}
              value={newUser.role}
              onChange={(val) => setNewUser({ ...newUser, role: val ?? 'user' })}
              size="md"
            />
          </div>
          {createUserMutation.isError && (
            <div className="system-settings__error">
              {createUserMutation.error instanceof Error
                ? createUserMutation.error.message
                : 'Failed to create user'}
            </div>
          )}
          <div className="system-settings__create-actions">
            <Button type="button" variant="ghost" onClick={() => setShowCreateModal(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={createUserMutation.isPending} loading={createUserMutation.isPending}>
              {createUserMutation.isPending ? 'Creating...' : 'Create User'}
            </Button>
          </div>
        </form>
      </Modal>
    </Modal>
  );
}
