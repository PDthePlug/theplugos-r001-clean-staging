import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RoleHeader } from './RoleHeader';
import { UserSession } from '../types';

const session: UserSession = {
  userId: 'staff-1',
  userName: 'Pride Mokoena',
  role: 'OWNER',
  businessId: 'business-1',
  branchId: 'branch-1',
  branchName: 'Soweto Central',
  deviceId: 'front-counter',
  permissions: ['*'],
  shiftId: 'shift-1',
  sessionToken: 'trusted-session',
};

describe('RoleHeader', () => {
  it('shows the operator, branch, role and current operating state', () => {
    render(
      <RoleHeader
        session={session}
        isOnline
        onToggleOnline={vi.fn()}
        outboxCount={4}
        onLockSession={vi.fn()}
        onOpenSyncDiagnostics={vi.fn()}
      />,
    );

    expect(screen.getByText('Owner')).toBeDefined();
    expect(screen.getByText('Soweto Central')).toBeDefined();
    expect(screen.getByText('Pride Mokoena')).toBeDefined();
    expect(screen.getByText('Live + local')).toBeDefined();
    expect(screen.getByText('4 safely queued')).toBeDefined();
  });

  it('keeps device and session actions behind the system menu', () => {
    const onToggleOnline = vi.fn();
    const onPair = vi.fn();
    const onLock = vi.fn();

    render(
      <RoleHeader
        session={session}
        isOnline={false}
        onToggleOnline={onToggleOnline}
        outboxCount={0}
        onLockSession={onLock}
        onOpenPairingWizard={onPair}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect cloud sync' }));
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    fireEvent.click(screen.getByRole('button', { name: /Pair a tablet/i }));

    expect(onToggleOnline).toHaveBeenCalledOnce();
    expect(onPair).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    fireEvent.click(screen.getByRole('button', { name: /Lock this station/i }));
    expect(onLock).toHaveBeenCalledOnce();
  });
});
