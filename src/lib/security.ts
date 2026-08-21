import { supabase } from './supabase';

export interface VerifyPinResult {
  authenticated: boolean;
  locked?: boolean;
  error?: string;
  staff?: {
    id: string;
    business_id: string;
    branch_id: string;
    name: string;
    role: string;
    status: string;
  };
  sessionToken?: string;
}

export interface PairDeviceResult {
  success: boolean;
  error?: string;
  deviceId?: string;
  businessId?: string;
  branchId?: string;
}

export interface DeviceStatusResult {
  active: boolean;
  status?: string;
  device?: {
    id?: string;
    device_id: string;
    business_id: string;
    branch_id: string;
    name: string;
    type: string;
    status: string;
  };
}

/**
 * Sets or updates a staff member's security PIN via trusted database RPC.
 * Credential is hashed using pgcrypto inside the database.
 * Fails closed if RPC is unavailable.
 */
export async function setStaffPin(
  staffId: string,
  businessId: string,
  branchId: string,
  pin: string,
  sessionToken?: string
): Promise<{ success: boolean; error?: string }> {
  if (!staffId || !businessId || !pin) {
    return { success: false, error: 'Staff ID, Business ID, and PIN are required.' };
  }

  const cleanPin = pin.trim();
  if (!/^\d{4,8}$/.test(cleanPin)) {
    return { success: false, error: 'PIN must be between 4 and 8 numeric digits.' };
  }

  try {
    const { data, error } = await supabase.rpc('set_staff_pin', {
      p_staff_id: staffId,
      p_business_id: businessId,
      p_branch_id: branchId || null,
      p_pin: cleanPin,
      p_session_token: sessionToken || null
    });

    if (error) {
      console.error('[SECURITY_SET_PIN_RPC_ERROR]', error);
      return { success: false, error: error.message || 'Security service unavailable.' };
    }

    const res = typeof data === 'string' ? JSON.parse(data) : data;
    if (res?.success) return { success: true };
    return { success: false, error: res?.error || 'Failed to set staff PIN.' };
  } catch (err: any) {
    console.error('[SECURITY_SET_PIN_EXCEPTION]', err);
    return { success: false, error: 'Security service unavailable.' };
  }
}

/**
 * Securely verifies a staff PIN for terminal authentication via trusted RPC.
 * Enforces atomic 5 failed attempts lockout (5 minutes) in database.
 * Fails closed if RPC is unavailable.
 */
export async function verifyStaffPin(
  staffId: string,
  businessId: string,
  branchId: string,
  pin: string
): Promise<VerifyPinResult> {
  if (!staffId || !businessId || !branchId || !pin) {
    return { authenticated: false, error: 'Staff ID, Business ID, Branch ID, and PIN are required.' };
  }

  const cleanPin = pin.trim();

  try {
    const { data, error } = await supabase.rpc('verify_staff_pin', {
      p_staff_id: staffId,
      p_business_id: businessId,
      p_branch_id: branchId,
      p_pin: cleanPin
    });

    if (error) {
      console.error('[SECURITY_VERIFY_PIN_RPC_ERROR]', error);
      return { authenticated: false, error: 'Authentication service unavailable.' };
    }

    const res = typeof data === 'string' ? JSON.parse(data) : data;
    return {
      authenticated: Boolean(res?.authenticated),
      locked: Boolean(res?.locked),
      error: res?.error,
      staff: res?.staff,
      sessionToken: res?.sessionToken
    };
  } catch (err) {
    console.error('[SECURITY_VERIFY_PIN_EXCEPTION]', err);
    return { authenticated: false, error: 'Authentication service unavailable.' };
  }
}

export interface CreatePairingCodeResult {
  success: boolean;
  code?: string;
  pairing_code?: string;
  expiresAt?: string;
  expires_at?: string;
  error?: string;
}

/**
 * Generates a single-use 6-digit enrollment code valid for 10 minutes via trusted RPC.
 * Fails closed if RPC is unavailable.
 */
export async function createDevicePairingCode(
  businessId: string,
  branchId: string,
  sessionToken?: string
): Promise<CreatePairingCodeResult> {
  if (!businessId || !branchId) {
    return { success: false, error: 'Business ID and Branch ID are required.' };
  }

  try {
    const { data, error } = await supabase.rpc('create_device_pairing_code', {
      p_business_id: businessId,
      p_branch_id: branchId,
      p_session_token: sessionToken || null
    });

    if (error) {
      console.error('[SECURITY_CREATE_PAIRING_CODE_RPC_ERROR]', error);
      return { success: false, error: error.message || 'Security service unavailable.' };
    }

    const res = typeof data === 'string' ? JSON.parse(data) : data;
    if (res?.success) {
      return { 
        success: true, 
        code: res.pairing_code, 
        pairing_code: res.pairing_code, 
        expiresAt: res.expires_at, 
        expires_at: res.expires_at 
      };
    }
    return { success: false, error: res?.error || 'Failed to create enrollment code.' };
  } catch (err: any) {
    console.error('[SECURITY_CREATE_PAIRING_CODE_EXCEPTION]', err);
    return { success: false, error: 'Security service unavailable.' };
  }
}

/**
 * Enrolls an untrusted device using a 6-digit enrollment code via trusted RPC.
 * Fails closed if RPC is unavailable.
 */
export async function pairDeviceWithCode(
  pairingCode: string,
  deviceId: string,
  deviceName: string,
  deviceType: string
): Promise<PairDeviceResult> {
  const cleanCode = pairingCode.trim();
  if (!cleanCode || !deviceId) {
    return { success: false, error: 'Enrollment code and device ID are required.' };
  }

  try {
    const { data, error } = await supabase.rpc('pair_device_with_code', {
      p_pairing_code: cleanCode,
      p_device_id: deviceId,
      p_device_name: deviceName || 'POS Terminal',
      p_device_type: deviceType || 'TERMINAL'
    });

    if (error) {
      console.error('[SECURITY_PAIR_DEVICE_RPC_ERROR]', error);
      return { success: false, error: error.message || 'Enrollment service unavailable.' };
    }

    const res = typeof data === 'string' ? JSON.parse(data) : data;
    if (res?.success) {
      return {
        success: true,
        deviceId: res.device_id,
        businessId: res.business_id,
        branchId: res.branch_id
      };
    }
    return { success: false, error: res?.error || 'Enrollment failed.' };
  } catch (err: any) {
    console.error('[SECURITY_PAIR_DEVICE_EXCEPTION]', err);
    return { success: false, error: 'Enrollment service unavailable.' };
  }
}

/**
 * Checks cloud device authorization via trusted RPC.
 * Returns active=false if device is REVOKED, NOT_FOUND, or service is unavailable.
 */
export async function verifyDeviceStatus(deviceId: string): Promise<DeviceStatusResult> {
  if (!deviceId) return { active: false, status: 'NO_DEVICE_ID' };

  try {
    const { data, error } = await supabase.rpc('verify_device_status', {
      p_device_id: deviceId
    });

    if (error) {
      console.error('[SECURITY_VERIFY_DEVICE_RPC_ERROR]', error);
      return { active: false, status: 'SERVICE_UNAVAILABLE' };
    }

    const res = typeof data === 'string' ? JSON.parse(data) : data;
    return {
      active: Boolean(res?.active),
      status: res?.status,
      device: res?.device
    };
  } catch (err) {
    console.error('[SECURITY_VERIFY_DEVICE_EXCEPTION]', err);
    return { active: false, status: 'SERVICE_UNAVAILABLE' };
  }
}

/**
 * Revokes trusted device access for a terminal via trusted RPC.
 * Fails closed if RPC is unavailable.
 */
export async function revokeDevice(
  businessId: string,
  deviceId: string,
  sessionToken?: string
): Promise<{ success: boolean; error?: string }> {
  if (!businessId || !deviceId) {
    return { success: false, error: 'Business ID and Device ID are required.' };
  }

  try {
    const { data, error } = await supabase.rpc('revoke_device', {
      p_business_id: businessId,
      p_device_id: deviceId,
      p_session_token: sessionToken || null
    });

    if (error) {
      console.error('[SECURITY_REVOKE_DEVICE_RPC_ERROR]', error);
      return { success: false, error: error.message || 'Device revocation service unavailable.' };
    }

    const res = typeof data === 'string' ? JSON.parse(data) : data;
    if (res?.success) return { success: true };
    return { success: false, error: res?.error || 'Device revocation failed.' };
  } catch (err: any) {
    console.error('[SECURITY_REVOKE_DEVICE_EXCEPTION]', err);
    return { success: false, error: 'Device revocation service unavailable.' };
  }
}

export interface DeviceBootstrapResult {
  success: boolean;
  error?: string;
  status?: string;
  business?: {
    id: string;
    name: string;
    onboarding_status: string;
    owner_id?: string;
  };
  branch?: {
    id: string;
    name: string;
    business_id: string;
  };
  staff?: any[];
  products?: any[];
}

/**
 * Retrieves secure bootstrap configuration for an active enrolled terminal.
 */
export async function getDeviceBootstrap(deviceId: string): Promise<DeviceBootstrapResult> {
  if (!deviceId) return { success: false, error: 'Device ID required.' };

  try {
    const { data, error } = await supabase.rpc('get_device_bootstrap', {
      p_device_id: deviceId
    });

    if (error) {
      console.error('[SECURITY_BOOTSTRAP_RPC_ERROR]', error);
      return { success: false, error: error.message || 'Device bootstrap unavailable.' };
    }

    const res = typeof data === 'string' ? JSON.parse(data) : data;
    return res as DeviceBootstrapResult;
  } catch (err: any) {
    console.error('[SECURITY_BOOTSTRAP_EXCEPTION]', err);
    return { success: false, error: 'Device bootstrap unavailable.' };
  }
}
