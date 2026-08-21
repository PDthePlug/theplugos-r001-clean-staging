import React, { useState } from 'react';
import { UserRole, UserSession } from '../types';
import {
  Activity,
  Building2,
  ChevronDown,
  Clock3,
  Lock,
  LogOut,
  Radio,
  Server,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';

interface RoleHeaderProps {
  session: UserSession;
  isOnline: boolean;
  onToggleOnline: () => void;
  outboxCount: number;
  onLockSession: () => void;
  onLogout?: () => void;
  onOpenHubInspector?: () => void;
  onOpenPairingWizard?: () => void;
  onOpenSyncDiagnostics?: () => void;
  activeShiftDuration?: string;
}

const roleNames: Record<UserRole, string> = {
  CASHIER: 'Cashier',
  KITCHEN_STAFF: 'Kitchen',
  MANAGER: 'Manager',
  OWNER: 'Owner',
  ADMINISTRATOR: 'Administrator',
};

const ShellMark = () => (
  <span className="plug-shell-mark" aria-hidden="true">
    <i /><i /><i /><i />
  </span>
);

export const RoleHeader: React.FC<RoleHeaderProps> = ({
  session,
  isOnline,
  onToggleOnline,
  outboxCount,
  onLockSession,
  onLogout,
  onOpenHubInspector,
  onOpenPairingWizard,
  onOpenSyncDiagnostics,
  activeShiftDuration = '02h 45m',
}) => {
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const canPairDevice =
    Boolean(onOpenPairingWizard) &&
    (session.role === 'OWNER' || session.role === 'MANAGER') &&
    Boolean(session.sessionToken);

  const runUtility = (action?: () => void) => {
    setUtilitiesOpen(false);
    action?.();
  };

  return (
    <header className="plug-shell-header">
      <div className="plug-shell-row">
        <div className="plug-shell-identity">
          <ShellMark />
          <div>
            <div className="plug-shell-title-line">
              <strong>ThePlugOS</strong>
              <span aria-hidden="true">/</span>
              <em className={`plug-role-chip role-${session.role.toLowerCase()}`}>
                {roleNames[session.role]}
              </em>
            </div>
            <p>
              <Building2 aria-hidden="true" />
              <span>{session.branchName}</span>
              <i aria-hidden="true" />
              <span>Business operations</span>
            </p>
          </div>
        </div>

        <div className="plug-shell-status" aria-label="Operating status">
          <button
            className={`plug-shell-state ${isOnline ? 'is-online' : 'is-local'}`}
            type="button"
            onClick={onToggleOnline}
            aria-label={isOnline ? 'Switch cloud sync offline' : 'Reconnect cloud sync'}
          >
            {isOnline ? <Wifi aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
            <span>
              <small>{isOnline ? 'Cloud connected' : 'Internet unavailable'}</small>
              <strong>{isOnline ? 'Live + local' : 'Local mode active'}</strong>
            </span>
          </button>

          {onOpenSyncDiagnostics && (
            <button
              className="plug-shell-state is-sync"
              type="button"
              onClick={onOpenSyncDiagnostics}
              aria-label="Open synchronization details"
            >
              <Activity aria-hidden="true" />
              <span>
                <small>Event movement</small>
                <strong>{outboxCount > 0 ? `${outboxCount} safely queued` : 'Everything synced'}</strong>
              </span>
            </button>
          )}

          <div className={`plug-shell-state ${session.shiftId ? 'is-shift' : 'is-muted'}`}>
            <Clock3 aria-hidden="true" />
            <span>
              <small>Current shift</small>
              <strong>{session.shiftId ? `${activeShiftDuration} active` : 'Not opened'}</strong>
            </span>
          </div>
        </div>

        <div className="plug-shell-operator">
          <div className="plug-operator-copy">
            <small>Signed in as</small>
            <strong>{session.userName}</strong>
          </div>
          <span className="plug-operator-avatar" aria-hidden="true">
            {session.userName?.trim().charAt(0).toUpperCase() || 'U'}
          </span>
          <button
            className="plug-utility-trigger"
            type="button"
            onClick={() => setUtilitiesOpen((current) => !current)}
            aria-expanded={utilitiesOpen}
            aria-controls="plug-shell-utilities"
          >
            <span>System</span>
            {utilitiesOpen ? <X aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
        </div>
      </div>

      {utilitiesOpen && (
        <div className="plug-utility-panel" id="plug-shell-utilities">
          <div className="plug-utility-context">
            <span className="plug-utility-device">Device {session.deviceId}</span>
            <span>Operational tools and session controls</span>
          </div>

          <div className="plug-utility-actions">
            {canPairDevice && (
              <button type="button" onClick={() => runUtility(onOpenPairingWizard)}>
                <Radio aria-hidden="true" />
                <span><strong>Pair a tablet</strong><small>Add a trusted cashier or kitchen device</small></span>
              </button>
            )}
            {onOpenHubInspector && (
              <button type="button" onClick={() => runUtility(onOpenHubInspector)}>
                <Server aria-hidden="true" />
                <span><strong>Local device mesh</strong><small>View nearby terminals and hub health</small></span>
              </button>
            )}
            {onOpenSyncDiagnostics && (
              <button type="button" onClick={() => runUtility(onOpenSyncDiagnostics)}>
                <Activity aria-hidden="true" />
                <span><strong>Movement details</strong><small>Inspect synchronization and queued events</small></span>
              </button>
            )}
            <button type="button" onClick={() => runUtility(onLockSession)}>
              <Lock aria-hidden="true" />
              <span><strong>Lock this station</strong><small>Keep the business open and switch operator</small></span>
            </button>
            {onLogout && (
              <button className="is-danger" type="button" onClick={() => runUtility(onLogout)}>
                <LogOut aria-hidden="true" />
                <span><strong>Sign out of business</strong><small>End this business session on the device</small></span>
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
