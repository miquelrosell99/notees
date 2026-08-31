/**
 * PageHeader tests: names containing "/" are literal text.
 *
 * The title shows the literal name and renaming to a name containing "/"
 * performs a plain rename — no parent resolution, no child creation,
 * no hierarchy preview.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PageHeader } from './PageHeader';
import type { Node } from '@/types';
import type * as ContentModule from '@/features/content';

const mocks = vi.hoisted(() => ({
  updateNode: { mutate: vi.fn(), mutateAsync: vi.fn() },
  createNode: { mutate: vi.fn(), mutateAsync: vi.fn() },
}));

vi.mock('@/features/content', async () => {
  const actual = await vi.importActual('@/features/content') as typeof ContentModule;
  return {
    ...actual,
    useUpdateNode: () => mocks.updateNode,
    useCreateNode: () => mocks.createNode,
    useAddClass: () => ({ mutate: vi.fn() }),
    useClassClass: () => ({ classClassUuid: 'class-class-uuid' }),
    useClasses: () => ({ data: [] }),
  };
});

vi.mock('@/features/queries', async () => {
  const actual = await vi.importActual('@/features/queries');
  return {
    ...actual as object,
    useNodeDisplayName: (node: Node | null | undefined) => node?.name ?? 'Untitled',
  };
});

vi.mock('@/features/auth', () => ({
  useAuthStore: () => 0,
}));

vi.mock('@/features/collab', () => {
  const useLivePresenceStore = Object.assign(
    () => undefined,
    { getState: () => ({ setLocalFocus: vi.fn() }) },
  );
  return {
    useLivePresenceStore,
    liveSyncManager: { sendFocus: vi.fn(), sendBlur: vi.fn() },
  };
});

vi.mock('@/stores', () => ({
  useNavigationStore: (selector: (s: { addSidebarCard: () => void }) => unknown) =>
    selector({ addSidebarCard: vi.fn() }),
}));

function makePage(name: string): Node {
  return {
    uuid: 'page-uuid-1',
    name,
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: true,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
  } as Node;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PageHeader literal "/" names', () => {
  it('displays a name containing "/" literally', () => {
    render(<PageHeader page={makePage('Parent/Child')} />);

    const title = screen.getByLabelText('Page title');
    expect(title).toHaveValue('Parent/Child');
  });

  it('shows no hierarchy preview while typing a name containing "/"', () => {
    render(<PageHeader page={makePage('Pokemon')} />);

    const title = screen.getByLabelText('Page title');
    fireEvent.change(title, { target: { value: 'Pokemon/Charizard' } });

    expect(screen.queryByText(/will create child/)).not.toBeInTheDocument();
    expect(screen.queryByText(/will move under/)).not.toBeInTheDocument();
    expect(screen.queryByText(/will rename to/)).not.toBeInTheDocument();
  });

  it('renames literally on blur without resolving or creating parent pages', () => {
    render(<PageHeader page={makePage('Pokemon')} />);

    const title = screen.getByLabelText('Page title');
    fireEvent.change(title, { target: { value: 'Pokemon/Charizard' } });
    fireEvent.blur(title, { target: { value: 'Pokemon/Charizard' } });

    expect(mocks.createNode.mutate).not.toHaveBeenCalled();
    expect(mocks.createNode.mutateAsync).not.toHaveBeenCalled();
    expect(mocks.updateNode.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.updateNode.mutate).toHaveBeenCalledWith({
      nodeUuid: 'page-uuid-1',
      data: { name: 'Pokemon/Charizard' },
    });
  });
});
