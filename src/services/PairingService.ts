/**
 * @deprecated Legacy pairing is permanently quarantined.
 *
 * Device enrollment is an authenticated Android-native Cashier Hub operation.
 * This compatibility surface fails closed so an old browser workflow cannot
 * manufacture a six-digit code, device identity, or business bootstrap cache.
 */
import type { PairingCodeRecord } from '../repositories/PairingRepository';
import type { DeviceRecord } from '../repositories/DeviceRepository';

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
    business: unknown;
    branches: unknown[];
    staff: unknown[];
    products: unknown[];
    suppliers: unknown[];
    vatConfig: unknown;
  };
}

export class LegacyPairingRetiredError extends Error {
  constructor() {
    super('Legacy browser pairing is retired. Open the authenticated Android-native Cashier Hub to authorize a device.');
    this.name = 'LegacyPairingRetiredError';
  }
}

export class PairingService {
  async generateCode(_: GeneratePairingCodeParams): Promise<PairingCodeRecord> {
    throw new LegacyPairingRetiredError();
  }

  async cancelCode(_: string): Promise<void> {
    throw new LegacyPairingRetiredError();
  }

  async getActiveCodeForBranch(_: string): Promise<PairingCodeRecord | null> {
    return null;
  }

  async validateCode(_: string): Promise<ValidationResult> {
    return { valid: false, error: new LegacyPairingRetiredError().message };
  }

  async downloadBusinessConfig(_: string): Promise<never> {
    throw new LegacyPairingRetiredError();
  }

  async registerPairedDevice(_: {
    pairingRecord: PairingCodeRecord;
    deviceName: string;
    deviceType: string;
  }): Promise<DeviceRecord> {
    throw new LegacyPairingRetiredError();
  }
}

export const pairingService = new PairingService();
