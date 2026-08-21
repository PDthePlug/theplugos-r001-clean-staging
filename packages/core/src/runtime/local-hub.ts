import type { KernelEvent } from '../events';
import { createLogger } from '../observability/logger';
import {
  DeviceNode,
  DeviceRegistrationRequest,
  FailureScenario,
  HubSnapshot,
  NativeHubBridge,
  NativeHubCommandReceipt,
  NativeHubCommandRequest,
  NativeHubOperatorContext,
  NetworkHealth,
  resolveNativeHubBridge,
  SecondaryTransportMetric,
  unavailableHubSnapshot
} from './native-hub-bridge';

export type {
  DeviceNode,
  DeviceRegistrationRequest,
  FailureScenario,
  NativeHubCommandReceipt,
  NativeHubCommandRequest,
  NativeHubOperatorContext,
  NetworkHealth,
  SecondaryTransportMetric
} from './native-hub-bridge';
export { NativeHubCapabilityError } from './native-hub-bridge';

const log = createLogger('LocalHubRuntime');

export class LocalHubRuntime {
  private snapshot: HubSnapshot = unavailableHubSnapshot('The Android-native Cashier Hub has not started.');
  private readonly listeners = new Set<(state: HubSnapshot) => void>();
  private nativeUnsubscribe: (() => void | Promise<void>) | null = null;
  private readonly bridge: NativeHubBridge;

  constructor(bridge: NativeHubBridge = resolveNativeHubBridge()) {
    this.bridge = bridge;
  }

  public async boot(): Promise<void> {
    await this.stopNativeSubscription();

    try {
      this.applySnapshot(await this.bridge.getSnapshot());
      this.nativeUnsubscribe = await this.bridge.subscribe((snapshot) => this.applySnapshot(snapshot));
      log.info(`Local hub capability: ${this.snapshot.networkHealth.availability}`);
    } catch (error: any) {
      this.applySnapshot(unavailableHubSnapshot(
        `The Android-native Cashier Hub could not be contacted: ${error?.message || 'unknown error'}`
      ));
      this.snapshot.networkHealth.availability = 'ERROR';
      log.error('Unable to start native local hub bridge', { error: error?.message });
    }
  }

  public async shutdown(): Promise<void> {
    await this.stopNativeSubscription();
  }

  public getDevices(): DeviceNode[] {
    return [...this.snapshot.devices];
  }

  public getNetworkHealth(): NetworkHealth {
    return { ...this.snapshot.networkHealth };
  }

  public getFailures(): FailureScenario[] {
    return [...this.snapshot.failures];
  }

  public getTransportMetrics(): SecondaryTransportMetric[] {
    return [...this.snapshot.transportMetrics];
  }

  public getOutbox(): KernelEvent[] {
    return [...this.snapshot.outbox];
  }

  public getInbox(): KernelEvent[] {
    return [...this.snapshot.inbox];
  }

  public async refresh(): Promise<void> {
    this.applySnapshot(await this.bridge.refresh());
  }

  public async registerDevice(
    device: Pick<DeviceRegistrationRequest, 'name' | 'role' | 'connectionType'>,
    options: { branchId: string; branchName?: string }
  ): Promise<DeviceNode> {
    const registered = await this.bridge.registerDevice({ ...device, ...options });
    await this.refresh();
    return registered;
  }

  public async revokeDevice(deviceId: string): Promise<void> {
    await this.bridge.revokeDevice(deviceId);
    await this.refresh();
  }

  public async openNativeEnrollment(): Promise<void> {
    await this.bridge.openNativeEnrollment();
  }

  public async openNativeStaffSignIn(): Promise<void> {
    await this.bridge.openNativeStaffSignIn();
  }

  public async getNativeOperatorContext(): Promise<NativeHubOperatorContext> {
    return this.bridge.getNativeOperatorContext();
  }

  public async submitNativeCommandRequest(request: NativeHubCommandRequest): Promise<NativeHubCommandReceipt> {
    const receipt = await this.bridge.submitNativeCommandRequest(request);
    await this.refresh();
    return receipt;
  }

  public async triggerSubnetScan(): Promise<DeviceNode[]> {
    const devices = await this.bridge.discoverDevices();
    await this.refresh();
    return devices;
  }

  /** Native-only test workflows will be surfaced by the Android Hub when available. */
  public async runFailureSimulation(_: string): Promise<void> {
    throw new Error('Failure certification is only available from the authenticated Android-native Hub test harness.');
  }

  public subscribe(listener: (state: HubSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applySnapshot(snapshot: HubSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private async stopNativeSubscription() {
    const unsubscribe = this.nativeUnsubscribe;
    this.nativeUnsubscribe = null;
    await unsubscribe?.();
  }
}

export const localHubRuntime = new LocalHubRuntime();
