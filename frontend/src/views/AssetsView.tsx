/**
 * AssetsView component.
 * 
 * Displays all assets in a database with grid or table view options.
 * Supports viewing, replacing, and deleting assets.
 */
import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAssets, deleteAsset, type Asset } from '../api/assets';
import { AssetPreview } from '../components/AssetPreview';
import { AssetUploadModal } from '../components/AssetUploadModal';
import { ConfirmationModal } from '../components/core/ConfirmationModal';
import { AttachmentIcon, DeleteIcon } from '../components/icons';
import { ButtonAdd } from '../components/core/ButtonAdd';
import { getLogger } from '../utils/logger';
import './AssetsView.css';

const log = getLogger('assets-view');

type ViewMode = 'grid' | 'table';

export function AssetsView() {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [assetToDelete, setAssetToDelete] = useState<Asset | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['assets'],
    queryFn: () => listAssets(1, 100),
  });

  const handleDeleteClick = useCallback((asset: Asset) => {
    if (deletingId) return;
    setAssetToDelete(asset);
  }, [deletingId]);

  const handleConfirmDelete = useCallback(async () => {
    if (!assetToDelete) return;

    try {
      setDeletingId(assetToDelete.uuid);
      await deleteAsset(assetToDelete.uuid);
      refetch();
      if (selectedAsset?.uuid === assetToDelete.uuid) {
        setSelectedAsset(null);
      }
      setAssetToDelete(null);
    } catch (err) {
      log.error('Failed to delete asset:', err);
    } finally {
      setDeletingId(null);
    }
  }, [assetToDelete, refetch, selectedAsset]);

  const handleCancelDelete = useCallback(() => {
    setAssetToDelete(null);
  }, []);

  const handleUploadComplete = useCallback(() => {
    refetch();
  }, [refetch]);

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (isLoading) {
    return (
      <div className="assets-view">
        <div className="assets-view__loading">Loading assets...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="assets-view">
        <div className="assets-view__error">Failed to load assets</div>
      </div>
    );
  }

  const assets = data?.assets ?? [];

  return (
    <div className="assets-view">
      <div className="assets-view__header">
        <div className="assets-view__title">
          <AttachmentIcon size="lg" />
          <h1>Assets</h1>
          <span className="assets-view__count">({assets.length})</span>
        </div>
        
        <div className="assets-view__actions">
          <div className="assets-view__view-toggle">
            <button
              className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="Grid view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="3" width="7" height="7" rx="1"/>
                <rect x="14" y="3" width="7" height="7" rx="1"/>
                <rect x="3" y="14" width="7" height="7" rx="1"/>
                <rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              title="Table view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="4" width="18" height="3" rx="1"/>
                <rect x="3" y="10" width="18" height="3" rx="1"/>
                <rect x="3" y="16" width="18" height="3" rx="1"/>
              </svg>
            </button>
          </div>
          
          <ButtonAdd 
            variant="primary"
            onClick={() => setIsUploadModalOpen(true)}
            title="Upload Asset"
            size="sm"
          >
            Upload Asset
          </ButtonAdd>
        </div>
      </div>

      {assets.length === 0 ? (
        <div className="assets-view__empty">
          <AttachmentIcon size="xl" />
          <h2>No assets yet</h2>
          <p>Upload images, audio files, and other assets to use in your pages.</p>
          <ButtonAdd 
            variant="primary"
            onClick={() => setIsUploadModalOpen(true)}
            title="Upload your first asset"
            size="sm"
          >
            Upload your first asset
          </ButtonAdd>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="assets-view__grid">
          {assets.map((asset) => (
            <div 
              key={asset.uuid}
              className={`asset-card ${selectedAsset?.uuid === asset.uuid ? 'selected' : ''}`}
              onClick={() => setSelectedAsset(asset)}
            >
              <div className="asset-card__preview">
                <AssetPreview
                  asset={asset}
                  controls={false}
                />
              </div>
              <div className="asset-card__info">
                <span className="asset-card__name" title={asset.filename}>
                  {asset.filename}
                </span>
                <span className="asset-card__size">{formatSize(asset.size_bytes)}</span>
              </div>
              <div className="asset-card__actions">
                <button
                  className="asset-card__delete"
                  onClick={(e) => { e.stopPropagation(); handleDeleteClick(asset); }}
                  disabled={deletingId === asset.uuid}
                  title="Delete"
                >
                  <DeleteIcon size="sm" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="assets-view__table-container">
          <table className="assets-view__table">
            <thead>
              <tr>
                <th>Preview</th>
                <th>Name</th>
                <th>Type</th>
                <th>Size</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr 
                  key={asset.uuid}
                  className={selectedAsset?.uuid === asset.uuid ? 'selected' : ''}
                  onClick={() => setSelectedAsset(asset)}
                >
                  <td className="table-preview">
                    <div className="table-preview__wrapper">
                      <AssetPreview
                        asset={asset}
                        controls={false}
                      />
                    </div>
                  </td>
                  <td className="table-name">{asset.filename}</td>
                  <td className="table-type">
                    <span className={`type-badge type-badge--${asset.category}`}>
                      {asset.category}
                    </span>
                  </td>
                  <td className="table-size">{formatSize(asset.size_bytes)}</td>
                  <td className="table-actions">
                    <button
                      className="table-action-btn table-action-btn--delete"
                      onClick={(e) => { e.stopPropagation(); handleDeleteClick(asset); }}
                      disabled={deletingId === asset.uuid}
                      title="Delete"
                    >
                      <DeleteIcon size="sm" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AssetUploadModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        onUpload={handleUploadComplete}
      />
      <ConfirmationModal
        isOpen={assetToDelete !== null}
        title="Delete Asset"
        message={`Are you sure you want to delete "${assetToDelete?.filename}"? This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />    </div>
  );
}

export default AssetsView;
