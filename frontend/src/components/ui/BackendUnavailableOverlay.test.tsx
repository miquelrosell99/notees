/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BackendUnavailableOverlay } from './BackendUnavailableOverlay';
import { useConnectionStore } from '@/stores/connectionStore';

describe('BackendUnavailableOverlay', () => {
  beforeEach(() => {
    useConnectionStore.setState({
      healthy: true,
      reason: null,
      lockUI: false,
      bannerDismissed: false,
      unhealthySince: null,
    });
  });

  it('renders nothing when the backend is healthy', () => {
    const { container } = render(<BackendUnavailableOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a dismissible warning banner for short outages', () => {
    useConnectionStore.setState({ healthy: false });

    render(<BackendUnavailableOverlay />);

    expect(screen.getByText(/Backend unreachable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument();
  });

  it('switches to a full-screen lock after the banner is dismissed', () => {
    useConnectionStore.setState({ healthy: false });

    render(<BackendUnavailableOverlay />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));

    expect(screen.getByText(/Backend is unreachable/i)).toBeInTheDocument();
  });

  it('shows the full-screen lock when the outage has been locked', () => {
    useConnectionStore.setState({ healthy: false, lockUI: true });

    render(<BackendUnavailableOverlay />);

    expect(screen.getByText(/Backend is unreachable/i)).toBeInTheDocument();
  });
});
