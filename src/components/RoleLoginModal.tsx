import React, { useEffect, useState } from 'react';
import { Branch, StaffMember, UserRole, UserSession } from '../types';
import { deviceRepository } from '../repositories/DeviceRepository';
import { verifyStaffPin } from '../lib/security';
import {
  AlertCircle,
  ArrowRight,
  Building2,
  CircleCheck,
  KeyRound,
  LockKeyhole,
  Store,
  UserRound,
  Wifi,
} from 'lucide-react';

interface RoleLoginModalProps {
  onLoginSuccess: (session: UserSession) => void;
  currentSession: UserSession | null;
  staffList?: StaffMember[];
  branches?: Branch[];
  businessId?: string;
}

const roleNames: Record<UserRole, string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  CASHIER: 'Cashier',
  KITCHEN_STAFF: 'Kitchen',
  ADMINISTRATOR: 'Administrator',
};

const roleDescriptions: Record<UserRole, string> = {
  OWNER: 'Business heartbeat and oversight',
  MANAGER: 'Branch operations and exceptions',
  CASHIER: 'Sales, payments and collection',
  KITCHEN_STAFF: 'Preparation and hand-off queue',
  ADMINISTRATOR: 'System health and security',
};

const getRolePermissions = (role: UserRole): string[] => {
  switch (role) {
    case 'OWNER':
      return ['BI_READ', 'FINANCIALS', 'BRANCH_WRITE', 'STRATEGY'];
    case 'MANAGER':
      return ['INVENTORY_WRITE', 'KITCHEN_READ', 'CASHIER_MONITOR', 'STAFF_SCHEDULE'];
    case 'CASHIER':
      return ['POS_CREATE', 'PAYMENT_PROCESS', 'RECEIPT_PRINT', 'SHIFT_CLOSE'];
    case 'KITCHEN_STAFF':
      return ['KDS_UPDATE', 'PREP_WORKFLOW', 'INGREDIENT_ALERT'];
    case 'ADMINISTRATOR':
      return ['SYSTEM_ALL', 'SECURITY_RULES', 'DEVICE_DISCOVERY', 'USER_MGMT'];
    default:
      return [];
  }
};

const OperatorMark = () => (
  <span className="plug-operator-mark" aria-hidden="true">
    <i /><i /><i /><i />
  </span>
);

export const RoleLoginModal: React.FC<RoleLoginModalProps> = ({
  onLoginSuccess,
  staffList = [],
  branches = [],
  businessId,
}) => {
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (staffList.length > 0 && !staffList.some((staff) => staff.id === selectedStaffId)) {
      setSelectedStaffId(staffList[0].id);
    }
    if (branches.length > 0 && !branches.some((branch) => branch.id === selectedBranchId)) {
      setSelectedBranchId(branches[0].id);
    }
  }, [staffList, branches, selectedStaffId, selectedBranchId]);

  const selectedStaff = staffList.find((staff) => staff.id === selectedStaffId) || staffList[0];
  const selectedBranch = branches.find((branch) => branch.id === selectedBranchId) || branches[0];

  const handleLoginSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedStaff) {
      setErrorMsg('Choose a staff profile before continuing.');
      return;
    }

    setSubmitting(true);
    setErrorMsg('');

    try {
      const localDeviceId = localStorage.getItem('plugos_device_id');
      if (localDeviceId) {
        const currentDevice = await deviceRepository.getById(localDeviceId);
        if (currentDevice?.status === 'DISABLED') {
          setErrorMsg('This device has been disabled. Ask the owner or manager to reactivate it.');
          return;
        }
      }

      console.log('[ROLE_LOGIN_ATTEMPT]', {
        staff_id: selectedStaff.id,
        staff_name: selectedStaff.name,
        branch_id: selectedBranch?.id || '',
      });

      const authResult = await verifyStaffPin(
        selectedStaff.id,
        businessId || '',
        selectedBranch?.id || '',
        pinInput,
      );

      if (!authResult.authenticated) {
        setErrorMsg(authResult.error || `That PIN does not match ${selectedStaff.name}.`);
        return;
      }

      const session: UserSession = {
        userId: selectedStaff.id,
        userName: selectedStaff.name,
        role: selectedStaff.role,
        businessId,
        branchId: selectedBranch?.id || '',
        branchName: selectedBranch?.name || 'Unknown branch',
        deviceId: localDeviceId || `DEV-${selectedStaff.role}-${Math.floor(Math.random() * 899 + 100)}`,
        permissions: getRolePermissions(selectedStaff.role),
        shiftId: selectedStaff.activeShift ? `SHIFT-${selectedStaff.id.slice(-3)}` : undefined,
        sessionToken: authResult.sessionToken,
      };

      onLoginSuccess(session);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="plug-operator-gate">
      <section className="plug-operator-card" aria-labelledby="operator-gate-title">
        <aside className="plug-operator-intro">
          <div className="plug-operator-brand">
            <OperatorMark />
            <span>ThePlugOS</span>
          </div>

          <div className="plug-operator-intro-copy">
            <p>Station access</p>
            <h1 id="operator-gate-title">Who is running this station?</h1>
            <span>
              Choose your profile and enter your four-digit PIN. The system will open only the
              workspace and actions assigned to your role.
            </span>
          </div>

          <div className="plug-operator-context">
            <div>
              <Building2 aria-hidden="true" />
              <span><small>Active branch</small><strong>{selectedBranch?.name || 'Branch not ready'}</strong></span>
            </div>
            <div>
              <Wifi aria-hidden="true" />
              <span><small>Station state</small><strong>Local access available</strong></span>
            </div>
            <div>
              <LockKeyhole aria-hidden="true" />
              <span><small>Security</small><strong>Role-isolated workspace</strong></span>
            </div>
          </div>
        </aside>

        <div className="plug-operator-form-side">
          <header>
            <p>Start working</p>
            <h2>Choose your profile.</h2>
          </header>

          {staffList.length === 0 ? (
            <div className="plug-operator-empty" role="status">
              <UserRound aria-hidden="true" />
              <div>
                <strong>No staff profiles are available yet.</strong>
                <span>The business may still be synchronising, or the owner needs to add the first team member.</span>
              </div>
            </div>
          ) : (
            <div className="plug-profile-grid" role="list" aria-label="Staff profiles">
              {staffList.map((staff) => {
                const selected = staff.id === selectedStaffId;
                return (
                  <button
                    key={staff.id}
                    type="button"
                    role="listitem"
                    className={`plug-profile-card role-${staff.role.toLowerCase()}${selected ? ' is-selected' : ''}`}
                    onClick={() => {
                      setSelectedStaffId(staff.id);
                      setPinInput('');
                      setErrorMsg('');
                    }}
                    aria-pressed={selected}
                  >
                    <span className="plug-profile-avatar" aria-hidden="true">
                      {staff.name.trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="plug-profile-copy">
                      <strong>{staff.name}</strong>
                      <small>{roleNames[staff.role]}</small>
                      <em>{roleDescriptions[staff.role]}</em>
                    </span>
                    {selected && <CircleCheck className="plug-profile-check" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}

          <form className="plug-station-form" onSubmit={handleLoginSubmit}>
            <div className="plug-station-fields">
              <label htmlFor="plug-station-branch">
                Operating branch
                <span className="plug-input-wrap">
                  <Store aria-hidden="true" />
                  <select
                    id="plug-station-branch"
                    value={selectedBranchId}
                    onChange={(event) => setSelectedBranchId(event.target.value)}
                  >
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.name}</option>
                    ))}
                  </select>
                </span>
              </label>

              <label htmlFor="plug-station-pin">
                Four-digit PIN
                <span className="plug-input-wrap">
                  <KeyRound aria-hidden="true" />
                  <input
                    id="plug-station-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={4}
                    required
                    value={pinInput}
                    onChange={(event) => setPinInput(event.target.value.replace(/\D/g, ''))}
                    placeholder="••••"
                    aria-describedby={errorMsg ? 'plug-station-error' : undefined}
                  />
                </span>
              </label>
            </div>

            {errorMsg && (
              <div className="plug-station-error" id="plug-station-error" role="alert">
                <AlertCircle aria-hidden="true" />
                <span>{errorMsg}</span>
              </div>
            )}

            <button
              className="plug-station-submit"
              type="submit"
              disabled={!selectedStaff || pinInput.length !== 4 || submitting}
            >
              <span>
                <small>Open workspace</small>
                <strong>{selectedStaff ? `${selectedStaff.name} · ${roleNames[selectedStaff.role]}` : 'Choose a profile'}</strong>
              </span>
              <ArrowRight aria-hidden="true" />
            </button>
          </form>
        </div>
      </section>
    </div>
  );
};

