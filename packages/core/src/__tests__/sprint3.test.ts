import { describe, it, expect, beforeEach } from 'vitest';
import { syncService } from '../services/sync';
import { eventEngine } from '../events';
import { storageEngine } from '../storage';
import { InMemoryStorageAdapter } from '../storage/adapters/in-memory';

describe('Phase 2 Sprint 3 - Synchronization Service', () => {
  beforeEach(async () => {
    await storageEngine.mount(new InMemoryStorageAdapter());
    eventEngine['subscribers'].clear();
    // re-register sync service 
    await syncService.boot();
  });

  it('should queue and sync events when online', async () => {
    syncService.setNetworkStatus(true);
    
    // Simulate event publishing
    await eventEngine.publish('ord-1', 'order', 'CREATE', { items: [] });
    
    // Wait for async sync simulated network
    await new Promise(r => setTimeout(r, 50));

    const outbox = await storageEngine.getAll(syncService['OUTBOX_COLLECTION']);
    expect(outbox).toHaveLength(0); // Synced and removed
  });

  it('should queue but not sync when offline', async () => {
    syncService.setNetworkStatus(false);
    
    await eventEngine.publish('ord-2', 'order', 'CREATE', { items: [] });
    
    await new Promise(r => setTimeout(r, 50));

    const outbox = await storageEngine.getAll(syncService['OUTBOX_COLLECTION']);
    expect(outbox).toHaveLength(1); // Still queued
  });

  it('should drain queue upon reconnection', async () => {
    syncService.setNetworkStatus(false);
    await eventEngine.publish('ord-3', 'order', 'CREATE', { items: [] });
    
    let outbox = await storageEngine.getAll(syncService['OUTBOX_COLLECTION']);
    expect(outbox).toHaveLength(1);

    syncService.setNetworkStatus(true); // Triggers drain
    await new Promise(r => setTimeout(r, 50));

    outbox = await storageEngine.getAll(syncService['OUTBOX_COLLECTION']);
    expect(outbox).toHaveLength(0);
  });
});
