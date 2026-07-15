import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilterBuilderModal } from './FilterBuilderModal';
import { useModalStore, useNavigationStore } from '@/stores';
import { createEmptyQueryAST, createClassCondition } from '@/types/queryAST';
import type { QueryAST } from '@/types/queryAST';

const openNodeCollectionMock = vi.fn();
const saveAsViewMock = vi.fn().mockResolvedValue(undefined);

const astWithCondition: QueryAST = {
  ...createEmptyQueryAST(),
  root_group: {
    type: 'group',
    logic: 'AND',
    children: [createClassCondition('cls-uuid-1')],
  },
};

// The mock exposes an "add condition" button so state changes go through
// fireEvent (act-wrapped) instead of bare callback invocations.
vi.mock('./ViewBuilder', () => ({
  ViewBuilder: ({ onChange }: { ast: QueryAST; onChange: (ast: QueryAST) => void }) => (
    <button type="button" data-testid="add-condition" onClick={() => onChange(astWithCondition)}>
      add condition
    </button>
  ),
}));

vi.mock('@/features/content/hooks/useNodeViews', () => ({
  useQueryCount: () => ({ data: 3 }),
}));

vi.mock('@/features/queries', () => ({
  useSaveQueryAsView: () => ({ saveAsView: saveAsViewMock, isSaving: false }),
}));

function renderOpen() {
  useModalStore.setState({ isFilterBuilderOpen: true });
  return render(<FilterBuilderModal />);
}

describe('FilterBuilderModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useModalStore.setState({ isFilterBuilderOpen: false });
    useNavigationStore.setState({ openNodeCollection: openNodeCollectionMock } as never);
  });

  it('disables Run and Save while the query has no conditions', () => {
    renderOpen();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /save as view/i })).toBeDisabled();
  });

  it('Run opens a temporary collection and closes the modal', () => {
    renderOpen();
    fireEvent.click(screen.getByTestId('add-condition'));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(openNodeCollectionMock).toHaveBeenCalledWith('Temporary query', astWithCondition);
    expect(useModalStore.getState().isFilterBuilderOpen).toBe(false);
  });

  it('uses the typed name as the collection title', () => {
    renderOpen();
    fireEvent.change(screen.getByLabelText('Query name'), { target: { value: 'Links to X' } });
    fireEvent.click(screen.getByTestId('add-condition'));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(openNodeCollectionMock).toHaveBeenCalledWith('Links to X', astWithCondition);
  });

  it('Save as view requires a name, then promotes via the save hook', () => {
    renderOpen();
    fireEvent.click(screen.getByTestId('add-condition'));
    expect(screen.getByRole('button', { name: /save as view/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Query name'), { target: { value: 'Links to X' } });
    fireEvent.click(screen.getByRole('button', { name: /save as view/i }));
    expect(saveAsViewMock).toHaveBeenCalledWith('Links to X', astWithCondition);
  });

  it('shows the debounced match count once a condition exists', async () => {
    renderOpen();
    fireEvent.click(screen.getByTestId('add-condition'));
    await waitFor(() => expect(screen.getByText('3 nodes found')).toBeInTheDocument());
  });
});
