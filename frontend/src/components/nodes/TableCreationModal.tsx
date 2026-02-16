/**
 * TableCreationModal — Small modal for configuring table dimensions before creation.
 *
 * Lets the user pick number of rows and columns, with optional header labels.
 * After confirmation, calls the onCreate callback with the chosen dimensions.
 */

import { useState, useCallback, type JSX } from 'react';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import './TableCreationModal.css';

export interface TableCreationConfig {
  rows: number;
  columns: number;
  headers: string[];
}

interface TableCreationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (config: TableCreationConfig) => void;
}

export function TableCreationModal({
  isOpen,
  onClose,
  onCreate,
}: TableCreationModalProps): JSX.Element {
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const [headers, setHeaders] = useState<string[]>(['', '', '']);

  // Keep headers array in sync with column count
  const handleColumnsChange = useCallback((newCols: number) => {
    setColumns(newCols);
    setHeaders(prev => {
      if (newCols > prev.length) {
        return [...prev, ...Array(newCols - prev.length).fill('')];
      }
      return prev.slice(0, newCols);
    });
  }, []);

  const handleHeaderChange = useCallback((index: number, value: string) => {
    setHeaders(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const handleCreate = useCallback(() => {
    onCreate({ rows, columns, headers });
    // Reset for next use
    setRows(3);
    setColumns(3);
    setHeaders(['', '', '']);
    onClose();
  }, [rows, columns, headers, onCreate, onClose]);

  const handleClose = useCallback(() => {
    setRows(3);
    setColumns(3);
    setHeaders(['', '', '']);
    onClose();
  }, [onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Create Table"
      size="sm"
      footer={
        <div className="table-creation-modal__footer">
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          <Button variant="primary" onClick={handleCreate}>Create</Button>
        </div>
      }
    >
      <div className="table-creation-modal">
        <div className="table-creation-modal__dimensions">
          <label className="table-creation-modal__field">
            <span className="table-creation-modal__label">Rows</span>
            <input
              type="number"
              min={1}
              max={50}
              value={rows}
              onChange={e => setRows(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
              className="table-creation-modal__input"
            />
          </label>
          <label className="table-creation-modal__field">
            <span className="table-creation-modal__label">Columns</span>
            <input
              type="number"
              min={1}
              max={20}
              value={columns}
              onChange={e => handleColumnsChange(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
              className="table-creation-modal__input"
            />
          </label>
        </div>

        <div className="table-creation-modal__headers">
          <span className="table-creation-modal__label">Column headers</span>
          <div className="table-creation-modal__header-inputs">
            {headers.map((header, i) => (
              <input
                key={i}
                type="text"
                placeholder={`Column ${i + 1}`}
                value={header}
                onChange={e => handleHeaderChange(i, e.target.value)}
                className="table-creation-modal__header-input"
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
