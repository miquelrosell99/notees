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
import { Separator } from '@/components/core/Separator';
import { listUsers, createAdminUser, updateAdminUser, deactivateAdminUser, getAdminMetrics } from '@/api/admin';
import type { AdminUserCreate, AdminUserUpdate } from '@/types';
import './SystemSettingsModal.css';

interface SystemSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SystemTab = 'users' | 'metrics';

export function SystemSettingsModal({ isOpen, onClose }: SystemSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SystemTab>('users');
  const queryClient = useQueryClient();

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  const updateUserMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: AdminUserUpdate }) => updateAdminUser(id, data),
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
  const [showCreateForm, setShowCreateForm] = useState(false);

  if (!isOpen) return null;

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    createUserMutation.mutate(newUser, {
      onSuccess: () => {
        setNewUser({ email: '', password: '', name: '', role: 'user' });
        setShowCreateForm(false);
      },
    });
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  };

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
              <Button variant="primary" size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
                {showCreateForm ? 'Cancel' : 'Add User'}
              </Button>
            </div>

            {showCreateForm && (
              <form onSubmit={handleCreateUser} className="system-settings__create-form">
                <TextField
                  id="new-user-email"
                  type="email"
                  label="Email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  required
                />
                <TextField
                  id="new-user-password"
                  type="password"
                  label="Password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  required
                />
                <TextField
                  id="new-user-name"
                  type="text"
                  label="Name"
                  value={newUser.name}
                  onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                />
                <div className="system-settings__role-select">
                  <label>Role</label>
                  <select
                    value={newUser.role}
                    onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <Button type="submit" variant="primary" size="sm" disabled={createUserMutation.isPending}>
                  {createUserMutation.isPending ? 'Creating...' : 'Create User'}
                </Button>
              </form>
            )}

            {usersLoading ? (
              <div className="system-settings__loading">Loading users...</div>
            ) : (
              <table className="system-settings__users-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {usersData?.users.map((user) => (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>{user.name || '-'}</td>
                      <td>
                        <span className={`system-settings__badge system-settings__badge--${user.role}`}>
                          {user.role}
                        </span>
                      </td>
                      <td>
                        <span className={`system-settings__badge system-settings__badge--${user.active ? 'active' : 'inactive'}`}>
                          {user.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        <div className="system-settings__actions">
                          {user.role === 'user' ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() =>
                                updateUserMutation.mutate({ id: user.id, data: { role: 'admin' } })
                              }
                              disabled={updateUserMutation.isPending}
                            >
                              Make Admin
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() =>
                                updateUserMutation.mutate({ id: user.id, data: { role: 'user' } })
                              }
                              disabled={updateUserMutation.isPending}
                            >
                              Demote
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                              if (window.confirm(`Deactivate ${user.email}?`)) {
                                deactivateUserMutation.mutate(user.id);
                              }
                            }}
                            disabled={deactivateUserMutation.isPending}
                          >
                            Deactivate
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
    </Modal>
  );
}
