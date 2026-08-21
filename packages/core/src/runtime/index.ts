import { createLogger } from '../observability/logger';
import { healthEngine } from '../observability/health';
import { storageEngine, IStorageAdapter } from '../storage';
import { eventEngine } from '../events';
import { configService } from '../config';
import { localHubRuntime } from './local-hub';

export * from './local-hub';

const log = createLogger('KernelRuntime');

export interface RuntimeOptions {
  storageAdapter: IStorageAdapter;
}

export class KernelRuntime {
  public async boot(options: RuntimeOptions): Promise<void> {
    log.info('--- ThePlugOS Kernel Booting ---');
    
    try {
      // 1. Mount Storage
      log.info('Phase 1: Mounting Storage...');
      await storageEngine.mount(options.storageAdapter);
      
      // 2. Load Configuration
      log.info('Phase 2: Loading Configuration...');
      await configService.load();
      
      // 3. Replay Events to hydrate state
      log.info('Phase 3: Restoring State...');
      const hwm = await import('../state').then(m => m.stateEngine.getHighWaterMark());
      const replayOffset = hwm >= 0 ? hwm + 1 : 0;
      await eventEngine.replay(replayOffset);

      // 4. Boot Local Hub Runtime for Distributed Local Operating Environment
      log.info('Phase 4: Booting Distributed Local Hub Runtime...');
      await localHubRuntime.boot();
      
      // 5. Register Health Checks
      healthEngine.registerCheck('StorageEngine', async () => {
        try {
          await storageEngine.get('system_health', 'ping');
          return { component: 'StorageEngine', status: 'HEALTHY', timestamp: new Date().toISOString() };
        } catch (e: any) {
          return { component: 'StorageEngine', status: 'UNHEALTHY', message: e.message, timestamp: new Date().toISOString() };
        }
      });

      healthEngine.registerCheck('LocalHubRuntime', async () => {
        const health = localHubRuntime.getNetworkHealth();
        return {
          component: 'LocalHubRuntime',
          status: health.packetLossRate < 0.5 ? 'HEALTHY' : 'DEGRADED',
          message: `Local Peers: ${health.localPeerCount}, Transport: ${health.activeTransport}`,
          timestamp: new Date().toISOString()
        };
      });

      log.info('--- ThePlugOS Kernel Online ---');
    } catch (err: any) {
      log.fatal('Kernel Boot Failed', { error: err.message, stack: err.stack });
      throw err;
    }
  }

  public async shutdown(): Promise<void> {
    log.info('Shutting down Kernel...');
    // Clean up adapters
    log.info('Kernel shutdown complete.');
  }
}

export const runtime = new KernelRuntime();

