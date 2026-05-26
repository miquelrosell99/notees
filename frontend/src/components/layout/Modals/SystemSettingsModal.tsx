/**
 * SystemSettingsModal Component
 *
 * Admin-only modal for system-level settings: user management, metrics.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { TextField } from '@/components/core/TextField';
import { Dropdown } from '@/components/core/Dropdown';
import { BooleanToggle } from '@/components/core/BooleanToggle';

import { Separator } from '@/components/core/Separator';
import { useAuthStore } from '@/stores';
import { listUsers, createAdminUser, updateAdminUser, deactivateAdminUser, getAdminMetrics } from '@/api/admin';
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

export function SystemSettingsModal({ isOpen, onClose }: SystemSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SystemTab>('users');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  const { data: usersData, isLoading: usersLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: listUsers,
    enabled: isOpen,
  });

  const { data: metricsData } = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: getAdminMetrics,
    enabled: isOpen && activeTab === 'metrics',
  });

  const createUserMutation = useMutation({
    mutationFn: createAdminUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setShowCreateModal(false);
      setNewUser({ email: '', password: '', name: '', role: 'user' });
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<AdminUserCreate> }) => updateAdminUser(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  const deactivateUserMutation = useMutation({
    mutationFn: deactivateAdminUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  const [newUser, setNewUser] = useState<AdminUserCreate>({
    email: '',
    password: '',
    name: '',
    role: 'user',
  });

  const adminCount = usersData?.users.filter((u) => u.role === 'admin' && u.active).length ?? 0;

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    createUserMutation.mutate(newUser);
  };

  const handleRoleChange = (userId: string, newRole: string | null) => {
    if (!newRole) return;
    updateUserMutation.mutate({ id: userId, data: { role: newRole } });
  };

  const handleActiveChange = (userId: string, active: boolean) => {
    updateUserMutation.mutate({ id: userId, data: { active } });
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
              <Button variant="primary" size="sm" icon="mdi mdi-plus" onClick={() => setShowCreateModal(true)}>
                Add User
              </Button>
            </div>

            {usersLoading ? (
              <div className="system-settings__loading">Loading users...</div>
            ) : (
              <div className="system-settings__table">
                <div className="system-settings__table-header">
                  <span>Email</span>
                  <span>Name</span>
                  <span>Role</span>
                  <span>Active</span>
                  <span>Actions</span>
                </div>
                {usersData?.users.map((user) => {
                  const isSelf = String(user.id) === String(currentUser?.id);
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
                        <Button
                          variant="danger"
                          size="xs"
                          icon="mdi mdi-trash-can"
                          confirm
                          confirmMessage={`Delete ${user.email}? This cannot be undone.`}
                          onClick={() => deactivateUserMutation.mutate(user.id)}
                          disabled={!canDeactivate || deactivateUserMutation.isPending}
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
              <div className="system-settings__loading">Loading metrics...</div>
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
            <label className="system-settings__field-label">Role</label>
            <Dropdown
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
            <Button type="submit" variant="primary" disabled={createUserMutation.isPending}>
              {createUserMutation.isPending ? 'Creating...' : 'Create User'}
            </Button>
          </div>
        </form>
      </Modal>
    </Modal>
  );
}
