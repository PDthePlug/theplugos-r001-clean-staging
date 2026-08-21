/**
 * @deprecated R002 QUARANTINED DEPRECATED REPOSITORY
 * Superseded by R002 database RPCs in src/lib/security.ts.
 * Do NOT use in production code paths.
 */
import { sdk } from '@plugos/sdk';
import { supabase } from '../lib/supabase';

export interface PairingCodeRecord {
  id?: string;
  pairing_code: string;
  code?: string;
  business_id: string;
  branch_id: string;
  created_by: string;
  created_at?: string;
  expires_at: string;
  used_at?: string | null;
  status: 'WAITING' | 'USED' | 'EXPIRED' | 'REVOKED';
}

export class PairingRepository {
  private collection = 'pairing_codes';

  async save(record: PairingCodeRecord): Promise<void> {
    // 1. Save to local sdk storage
    await sdk.storage.set(this.collection, record.pairing_code, record);
    const allCodes: PairingCodeRecord[] = (await sdk.storage.get(this.collection, 'all_records')) || [];
    const idx = allCodes.findIndex(c => c.pairing_code === record.pairing_code);
    if (idx >= 0) {
      allCodes[idx] = record;
    } else {
      allCodes.push(record);
    }
    await sdk.storage.set(this.collection, 'all_records', allCodes);

    // 2. Persist to Supabase device_pairing_codes table
    if (supabase) {
      try {
        const payload = {
          id: record.id || `pr-${record.pairing_code}-${Date.now()}`,
          pairing_code: record.pairing_code,
          code: record.pairing_code,
          business_id: record.business_id,
          branch_id: record.branch_id,
          created_by: record.created_by,
          created_at: record.created_at || new Date().toISOString(),
          expires_at: record.expires_at,
          used_at: record.used_at || null,
          status: record.status
        };
        const { error } = await supabase.from('device_pairing_codes').upsert([payload]);
        if (error) {
          console.warn('[SUPABASE PAIRING SAVE WARNING]', error.message);
        }
      } catch (err) {
        console.warn('[SUPABASE PAIRING SAVE EXCEPTION]', err);
      }
    }

    console.log(`[PAIRING DEBUG]\nGENERATE\nbusinessId: ${record.business_id}\nbranchId: ${record.branch_id}\ncode: [REDACTED]\nstorage: SUPABASE & SERVER\nstatus: SUCCESS`);
  }

  async getByCode(code: string): Promise<PairingCodeRecord | null> {
    const trimmed = code.trim();

    // 1. Try Central Server API first (cross-device authority)
    try {
      const res = await fetch('/api/pairing/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.pairingRecord) {
          return data.pairingRecord as PairingCodeRecord;
        }
      }
    } catch (e) {
      console.warn('[PAIRING REPO] Server API validate fetch failed, checking Supabase/local:', e);
    }

    // 2. Try direct Supabase query against device_pairing_codes table
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('device_pairing_codes')
          .select('*')
          .or(`pairing_code.eq.${trimmed},code.eq.${trimmed}`)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (data && !error) {
          const rec: PairingCodeRecord = {
            id: data.id,
            pairing_code: data.pairing_code || data.code,
            code: data.code || data.pairing_code,
            business_id: data.business_id,
            branch_id: data.branch_id,
            created_by: data.created_by,
            created_at: data.created_at,
            expires_at: data.expires_at,
            used_at: data.used_at,
            status: data.status
          };
          return rec;
        }
      } catch (err) {
        console.warn('[PAIRING REPO] Supabase getByCode exception:', err);
      }
    }

    // 3. Fallback to local storage (same-device testing fallback)
    const record = await sdk.storage.get(this.collection, trimmed);
    if (record) return record;
    const allCodes: PairingCodeRecord[] = (await sdk.storage.get(this.collection, 'all_records')) || [];
    return allCodes.find(c => c.pairing_code === trimmed) || null;
  }

  async getActiveByBranch(branchId: string): Promise<PairingCodeRecord | null> {
    // Try Server API
    try {
      const res = await fetch(`/api/pairing/active-code?branchId=${encodeURIComponent(branchId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.activeCode) return data.activeCode;
      }
    } catch (e) {
      // ignore
    }

    // Try Supabase
    if (supabase) {
      try {
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from('device_pairing_codes')
          .select('*')
          .eq('branch_id', branchId)
          .eq('status', 'WAITING')
          .gt('expires_at', now)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (data && !error) {
          return {
            id: data.id,
            pairing_code: data.pairing_code || data.code,
            code: data.code || data.pairing_code,
            business_id: data.business_id,
            branch_id: data.branch_id,
            created_by: data.created_by,
            created_at: data.created_at,
            expires_at: data.expires_at,
            used_at: data.used_at,
            status: data.status
          };
        }
      } catch (err) {
        // ignore
      }
    }

    // Local fallback
    const allCodes: PairingCodeRecord[] = (await sdk.storage.get(this.collection, 'all_records')) || [];
    const now = new Date().toISOString();
    return allCodes.find(c => 
      c.branch_id === branchId && 
      c.status === 'WAITING' && 
      c.expires_at > now
    ) || null;
  }

  async cancelBranchCodes(branchId: string): Promise<void> {
    // 1. Local sdk storage
    const allCodes: PairingCodeRecord[] = (await sdk.storage.get(this.collection, 'all_records')) || [];
    for (const c of allCodes) {
      if (c.branch_id === branchId && c.status === 'WAITING') {
        c.status = 'REVOKED';
        await sdk.storage.set(this.collection, c.pairing_code, c);
      }
    }
    await sdk.storage.set(this.collection, 'all_records', allCodes);

    // 2. Supabase
    if (supabase) {
      try {
        await supabase
          .from('device_pairing_codes')
          .update({ status: 'REVOKED' })
          .eq('branch_id', branchId)
          .eq('status', 'WAITING');
      } catch (e) {
        // ignore
      }
    }
  }

  async updateStatus(code: string, status: 'WAITING' | 'USED' | 'EXPIRED' | 'REVOKED', usedAt?: string): Promise<void> {
    const trimmed = code.trim();
    const record = await this.getByCode(trimmed);
    if (record) {
      record.status = status;
      if (usedAt) record.used_at = usedAt;
      await this.save(record);
    }

    if (supabase) {
      try {
        await supabase
          .from('device_pairing_codes')
          .update({ status, used_at: usedAt || null })
          .or(`pairing_code.eq.${trimmed},code.eq.${trimmed}`);
      } catch (e) {
        // ignore
      }
    }
  }

  async getAll(): Promise<PairingCodeRecord[]> {
    const records = await sdk.storage.get(this.collection, 'all_records');
    return Array.isArray(records) ? records : [];
  }
}

export const pairingRepository = new PairingRepository();
