import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmationModal } from './ConfirmationModal';

function renderModal(overrides: Partial<Parameters<typeof ConfirmationModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmationModal
      isOpen
      title="Delete page"
      message="Are you sure?"
      variant="danger"
      confirmLabel="Delete"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

describe('ConfirmationModal', () => {
  it('confirms on Enter when the target is the dialog body', async () => {
    const { onConfirm } = renderModal();
    fireEvent.keyDown(screen.getByText('Are you sure?'), { key: 'Enter' });
    // Flush the async handleConfirm continuation inside act().
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does NOT confirm on Enter when the Cancel button is focused', async () => {
    const { onConfirm, onCancel } = renderModal();
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT double-confirm on Enter when the Confirm button is focused', async () => {
    const { onConfirm } = renderModal();
    screen.getByRole('button', { name: 'Delete' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and stays open when onConfirm rejects', async () => {
    const { onCancel } = renderModal({
      onConfirm: vi.fn().mockRejectedValue(new Error('Server exploded')),
    });
    fireEvent.keyDown(screen.getByText('Are you sure?'), { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Server exploded');
    // Modal stays open: both actions are still available.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
