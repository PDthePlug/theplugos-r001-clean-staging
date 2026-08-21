import { sdk } from '@plugos/sdk';
import { supabase } from '../lib/supabase';

export interface DeviceRecord {
  device_id: string;
  business_id: string;
  branch_id: string;
  device_name: string;
  device_type: 'OWNER' | 'MANAGER' | 'CASHIER' | 'KITCHEN' | string;
  status: 'ACTIVE' | 'DISABLED';
  last_seen: string;
  certFingerprint?: string;
  connectionType?: string;
}

export class DeviceRepository {
  private collection = 'devices';

  async save(device: DeviceRecord): Promise<void> {
    // 1. Save to local sdk storage
    await sdk.storage.set(this.collection, device.device_id, device);
    const allDevices = await this.getAll();
    const idx = allDevices.findIndex(d => d.device_id === device.device_id);
    if (idx >= 0) {
      allDevices[idx] = device;
    } else {
      allDevices.push(device);
    }
    await sdk.storage.set(this.collection, 'all_records', allDevices);

    // 2. Sync to Server API
    try {
      await fetch('/api/devices/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(device)
      });
    } catch (e) {
      // ignore offline
    }

    // 3. Sync to Supabase
    if (supabase) {
      try {
        await supabase.from('devices').upsert([device]);
        await supabase.from('device_records').upsert([device]);
      } catch (e) {
        // ignore
      }
    }
  }

  async getById(deviceId: string): Promise<DeviceRecord | null> {
    const device = await sdk.storage.get(this.collection, deviceId);
    if (device) return device;
    const all = await this.getAll();
    return all.find(d => d.device_id === deviceId) || null;
  }

  async getForBusiness(businessId: string): Promise<DeviceRecord[]> {
    // Try Server API
    try {
      const res = await fetch(`/api/devices?businessId=${encodeURIComponent(businessId)}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.devices) && data.devices.length > 0) {
          return data.devices;
        }
      }
    } catch (e) {
      // ignore
    }

    // Try Supabase
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('devices')
          .select('*')
          .eq('business_id', businessId);
        if (data && !error && data.length > 0) {
          return data;
        }
      } catch (e) {
        // ignore
      }
    }

    const all = await this.getAll();
    return all.filter(d => d.business_id === businessId);
  }

  async updateStatus(deviceId: string, status: 'ACTIVE' | 'DISABLED'): Promise<void> {
    const device = await this.getById(deviceId);
    if (device) {
      device.status = status;
      await this.save(device);
    }
  }

  async updateName(deviceId: string, name: string): Promise<void> {
    const device = await this.getById(deviceId);
    if (device) {
      device.device_name = name;
      await this.save(device);
    }
  }

  async updateLastSeen(deviceId: string): Promise<void> {
    const device = await this.getById(deviceId);
    if (device) {
      device.last_seen = new Date().toISOString();
      await this.save(device);
    }
  }

  async remove(deviceId: string): Promise<void> {
    await sdk.storage.set(this.collection, deviceId, null);
    const all = await this.getAll();
    const filtered = all.filter(d => d.device_id !== deviceId);
    await sdk.storage.set(this.collection, 'all_records', filtered);
  }

  async getAll(): Promise<DeviceRecord[]> {
    const records = await sdk.storage.get(this.collection, 'all_records');
    return Array.isArray(records) ? records : [];
  }
}

export const deviceRepository = new DeviceRepository();
