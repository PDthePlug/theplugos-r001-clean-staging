/**
 * @deprecated R002 QUARANTINED DEPRECATED SERVICE
 * The legacy PairingService has been superseded by R002 RPC security primitives
 * (create_device_pairing_code, pair_device_with_code, get_device_bootstrap, etc.) in src/lib/security.ts.
 * Do NOT use in production code paths.
 */
import { pairingRepository, PairingCodeRecord } from '../repositories/PairingRepository';
import { deviceRepository, DeviceRecord } from '../repositories/DeviceRepository';
import { sdk } from '@plugos/sdk';
import { supabase } from '../lib/supabase';
import { getOrCreateDeviceId } from '../lib/deviceIdentity';
import { mapStaffRowToStaffMember, mapCatalogProductRowToProductItem, mapBranchRowToBranch } from '../lib/mappers';

export interface GeneratePairingCodeParams {
  businessId: string;
  branchId: string;
  createdBy: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  pairingRecord?: PairingCodeRecord;
  businessConfig?: {
    business: any;
    branches: any[];
    staff: any[];
    products: any[];
    suppliers: any[];
    vatConfig: any;
  };
}

export class PairingService {
  /**
   * Generate a secure 6-digit numeric pairing code.
   * Ensures only one active WAITING pairing code per branch at a time.
   */
  async generateCode(params: GeneratePairingCodeParams): Promise<PairingCodeRecord> {
    const businessId = params.businessId?.trim();
    const branchId = params.branchId?.trim();
    if (!businessId || !branchId) {
      throw new Error('Device enrollment is incomplete. Business or branch context could not be resolved.');
    }
    const createdBy = params.createdBy || 'Owner';

    // 1. Cancel any existing WAITING codes for this branch
    await pairingRepository.cancelBranchCodes(branchId);

    // 2. Try Server API generation
    let record: PairingCodeRecord | null = null;
    try {
      const res = await fetch('/api/pairing/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId, branchId, createdBy })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.record) {
          record = data.record;
        }
      }
    } catch (e) {
      console.warn('[PAIRING SERVICE] Server API generate failed, generating locally:', e);
    }

    if (!record) {
      const pairing_code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

      record = {
        id: `pr-${pairing_code}-${Date.now()}`,
        pairing_code,
        code: pairing_code,
        business_id: businessId,
        branch_id: branchId,
        created_by: createdBy,
        expires_at: expiresAt,
        used_at: null,
        status: 'WAITING'
      };
    }

    await pairingRepository.save(record);

    // 3. Sync operational business config to server so paired Device B can download it
    try {
      const currentBiz = await sdk.storage.get('businesses', businessId) || await sdk.storage.get('businesses', 'current');
      const branches = await sdk.storage.get('branches', 'directory') || [];
      const staff = await sdk.storage.get('staff', 'directory') || [];
      const products = await sdk.storage.get('catalog', 'products') || [];
      const suppliers = await sdk.storage.get('suppliers', 'directory') || [];
      const vatConfig = await sdk.storage.get('config', 'vat') || { enabled: false, rate: 15 };

      await fetch('/api/pairing/business-config/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId,
          config: {
            business: currentBiz,
            branches,
            staff,
            products,
            suppliers,
            vatConfig
          }
        })
      });
    } catch (e) {
      // ignore
    }

    return record;
  }

  /**
   * Cancel/revoke an active pairing code.
   */
  async cancelCode(code: string): Promise<void> {
    try {
      await fetch('/api/pairing/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() })
      });
    } catch (e) {
      // ignore
    }
    await pairingRepository.updateStatus(code, 'REVOKED');
  }

  /**
   * Get active code for branch
   */
  async getActiveCodeForBranch(branchId: string): Promise<PairingCodeRecord | null> {
    return pairingRepository.getActiveByBranch(branchId);
  }

  /**
   * Validate incoming pairing request.
   * Single-use, expiration, status checks.
   */
  async validateCode(code: string): Promise<ValidationResult> {
    const trimmedCode = code.trim();

    // 1. Try Server API first
    try {
      const res = await fetch('/api/pairing/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmedCode })
      });
      if (res.ok) {
        const data = await res.json();
        if (!data.valid) {
          return { valid: false, error: data.error };
        }
        if (data.valid && data.pairingRecord) {
          const config = data.businessConfig || await this.downloadBusinessConfig(data.pairingRecord.business_id);
          return {
            valid: true,
            pairingRecord: data.pairingRecord,
            businessConfig: config
          };
        }
      }
    } catch (e) {
      console.warn('[PAIRING SERVICE] Server API validate call failed:', e);
    }

    // 2. Fallback to pairingRepository (queries Supabase / local storage)
    const record = await pairingRepository.getByCode(trimmedCode);
    if (!record) {
      return { valid: false, error: 'Pairing code not found. Please check the 6-digit code.' };
    }

    if (record.status === 'USED') {
      return { valid: false, error: 'This pairing code has already been used.' };
    }

    if (record.status === 'REVOKED') {
      return { valid: false, error: 'This pairing code was cancelled by the owner.' };
    }

    const now = new Date().toISOString();
    if (record.expires_at <= now || record.status === 'EXPIRED') {
      await pairingRepository.updateStatus(trimmedCode, 'EXPIRED');
      return { valid: false, error: 'Pairing code has expired. Please generate a new code.' };
    }

    // Download operational business config
    const businessConfig = await this.downloadBusinessConfig(record.business_id);

    return {
      valid: true,
      pairingRecord: record,
      businessConfig
    };
  }

  /**
   * Download operational business configuration.
   */
  async downloadBusinessConfig(businessId: string) {
    let business: any = null;
    let branches: any[] = [];
    let staff: any[] = [];
    let products: any[] = [];
    let suppliers: any[] = [];
    let vatConfig: any = null;

    // 1. Try Server API
    try {
      const res = await fetch(`/api/pairing/business-config/${encodeURIComponent(businessId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          business = data.config.business;
          branches = data.config.branches || [];
          staff = data.config.staff || [];
          products = data.config.products || [];
          suppliers = data.config.suppliers || [];
          vatConfig = data.config.vatConfig;
        }
      }
    } catch (e) {
      // ignore
    }

    // 2. Try Supabase
    if (supabase && (!staff.length || !products.length)) {
      try {
        if (!business) {
          const { data: bData } = await supabase.from('businesses').select('*').eq('id', businessId).maybeSingle();
          if (bData) business = bData;
        }
        if (!branches.length) {
          const { data: brData } = await supabase.from('branches').select('*').eq('business_id', businessId);
          if (brData) branches = brData.map(mapBranchRowToBranch);
        }
        if (!staff.length) {
          const { data: stData } = await supabase.from('staff_members').select('*').eq('business_id', businessId);
          if (stData) staff = stData.map(mapStaffRowToStaffMember);
        }
        if (!products.length) {
          const { data: prData } = await supabase.from('catalog_products').select('*').eq('business_id', businessId);
          if (prData) products = prData.map(mapCatalogProductRowToProductItem);
        }
      } catch (e) {
        // ignore
      }
    }

    // 3. Fallback to local sdk storage
    if (!business) {
      business = (await sdk.storage.get('businesses', businessId)) || 
                 (await sdk.storage.get('businesses', 'current')) || 
                 { id: businessId, name: 'Paired Business' };
    }
    if (!branches.length) {
      branches = (await sdk.storage.get('branches', 'directory')) || [];
    }
    if (!staff.length) {
      staff = (await sdk.storage.get('staff', 'directory')) || [];
    }
    if (!products.length) {
      products = (await sdk.storage.get('catalog', 'products')) || [];
    }
    if (!suppliers.length) {
      suppliers = (await sdk.storage.get('suppliers', 'directory')) || [];
    }
    if (!vatConfig) {
      vatConfig = (await sdk.storage.get('config', 'vat')) || { enabled: false, rate: 15 };
    }

    return {
      business,
      branches,
      staff,
      products,
      suppliers,
      vatConfig
    };
  }

  /**
   * Register paired device.
   * Marks pairing code as USED and creates new record in DeviceRepository.
   */
  async registerPairedDevice(params: {
    pairingRecord: PairingCodeRecord;
    deviceName: string;
    deviceType: string;
  }): Promise<DeviceRecord> {
    const { pairingRecord, deviceName, deviceType } = params;
    const deviceId = getOrCreateDeviceId();

    // 1. Mark code as USED & Register device via Server API
    try {
      await fetch('/api/pairing/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingRecord, deviceName, deviceType, deviceId })
      });
    } catch (e) {
      // ignore
    }

    // 2. Mark code as USED locally & in Supabase
    await pairingRepository.updateStatus(pairingRecord.pairing_code, 'USED', new Date().toISOString());

    // 3. Register device locally (idempotently)
    const device: DeviceRecord = {
      device_id: deviceId,
      business_id: pairingRecord.business_id,
      branch_id: pairingRecord.branch_id,
      device_name: deviceName || 'Terminal Device',
      device_type: deviceType || 'CASHIER',
      status: 'ACTIVE',
      last_seen: new Date().toISOString()
    };

    await deviceRepository.save(device);

    return device;
  }
}

export const pairingService = new PairingService();
