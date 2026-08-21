import { createLogger } from '../observability/logger';
import { KernelEvent, eventEngine } from '../events';
import { storageEngine } from '../storage';
import { certificateAuthority, DeviceCertificate } from '../security/certificates';

const log = createLogger('LocalHubRuntime');

export interface DeviceNode {
  id: string;
  name: string;
  role: 'CASHIER' | 'KITCHEN_STAFF' | 'MANAGER' | 'OWNER' | 'ADMINISTRATOR' | 'PRINTER' | 'DISPLAY';
  ipAddress: string;
  status: 'ACTIVE' | 'DEGRADED' | 'OFFLINE';
  lastHeartbeat: string;
  latencyMs: number;
  certFingerprint: string;
  queuedEvents: number;
  connectionType: 'LAN_WIFI' | 'BLE_FALLBACK' | 'MESH_P2P' | 'ETHERNET';
  isHub?: boolean;
}

export interface NetworkHealth {
  mode: 'LOCAL_HUB_PRIMARY' | 'STANDALONE_FALLBACK' | 'CLOUD_SYNCHRONIZED';
  localPeerCount: number;
  packetLossRate: number; // 0 to 1
  latencyMs: number;
  outboxDepth: number;
  inboxDepth: number;
  lastSyncTimestamp: string;
  cloudConnected: boolean;
  activeTransport: 'LAN_WIFI' | 'BLE' | 'P2P_MESH' | 'ETHERNET';
}

export interface FailureScenario {
  id: string;
  title: string;
  description: string;
  impact: string;
  recoveryMechanism: string;
  status: 'IDLE' | 'SIMULATING' | 'RECOVERING' | 'RESOLVED';
}

export interface SecondaryTransportMetric {
  name: string;
  type: 'LAN_WIFI' | 'BLE' | 'WIFI_DIRECT' | 'P2P_MESH' | 'USB_ETHERNET';
  bandwidthMbps: number;
  maxLatencyMs: number;
  maxDevices: number;
  batteryImpact: 'LOW' | 'MEDIUM' | 'HIGH';
  rangeMeters: number;
  townshipSuitabilityScore: number; // 1-10
  status: 'PRIMARY' | 'EVALUATED_FALLBACK' | 'EXPERIMENTAL';
  recommendation: string;
}

export class LocalHubRuntime {
  private devices: Map<string, DeviceNode> = new Map();
  private isHubActive: boolean = true;
  private networkHealth: NetworkHealth;
  private broadcastChannel: BroadcastChannel | null = null;
  private outbox: KernelEvent[] = [];
  private inbox: KernelEvent[] = [];
  private processedEventIds: Set<string> = new Set();
  private simulatedFailures: FailureScenario[] = [];
  private transportMetrics: SecondaryTransportMetric[] = [];
  private listeners: Set<(state: any) => void> = new Set();

  constructor() {
    this.networkHealth = {
      mode: 'LOCAL_HUB_PRIMARY',
      localPeerCount: 1,
      packetLossRate: 0.0,
      latencyMs: 1.2,
      outboxDepth: 0,
      inboxDepth: 0,
      lastSyncTimestamp: new Date().toISOString(),
      cloudConnected: true,
      activeTransport: 'LAN_WIFI'
    };

    this.initDefaultNodes();
    this.initFailures();
    this.initTransportMetrics();
  }

  private initDefaultNodes() {
    const now = new Date().toISOString();
    const initialNodes: DeviceNode[] = [
      {
        id: 'HUB-SOWETO-PRIMARY',
        name: 'Soweto Central Local Hub (Primary)',
        role: 'ADMINISTRATOR',
        ipAddress: '192.168.1.100',
        status: 'ACTIVE',
        lastHeartbeat: now,
        latencyMs: 1.2,
        certFingerprint: 'SHA256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        queuedEvents: 0,
        connectionType: 'ETHERNET',
        isHub: true
      }
    ];

    initialNodes.forEach(node => this.devices.set(node.id, node));
  }

  private initFailures() {
    this.simulatedFailures = [];
  }

  private initTransportMetrics() {
    this.transportMetrics = [
      {
        name: 'Local Wi-Fi LAN (802.11ax)',
        type: 'LAN_WIFI',
        bandwidthMbps: 1200,
        maxLatencyMs: 4,
        maxDevices: 64,
        batteryImpact: 'LOW',
        rangeMeters: 50,
        townshipSuitabilityScore: 10,
        status: 'PRIMARY',
        recommendation: 'Mandatory primary transport for high-throughput multi-tablet township hub routing.'
      },
      {
        name: 'Bluetooth Low Energy (BLE 5.3)',
        type: 'BLE',
        bandwidthMbps: 2,
        maxLatencyMs: 35,
        maxDevices: 8,
        batteryImpact: 'LOW',
        rangeMeters: 15,
        townshipSuitabilityScore: 8,
        status: 'EVALUATED_FALLBACK',
        recommendation: 'Recommended as secondary offline emergency fallback for cash register printing and direct terminal-to-kds pulse.'
      },
      {
        name: 'Wi-Fi Direct / P2P Mesh',
        type: 'P2P_MESH',
        bandwidthMbps: 300,
        maxLatencyMs: 12,
        maxDevices: 16,
        batteryImpact: 'MEDIUM',
        rangeMeters: 30,
        townshipSuitabilityScore: 9,
        status: 'EVALUATED_FALLBACK',
        recommendation: 'Highly recommended fallback when local router hardware fails entirely without router intervention.'
      },
      {
        name: 'USB-C / Ethernet Tethering',
        type: 'USB_ETHERNET',
        bandwidthMbps: 1000,
        maxLatencyMs: 1,
        maxDevices: 4,
        batteryImpact: 'LOW',
        rangeMeters: 5,
        townshipSuitabilityScore: 7,
        status: 'EVALUATED_FALLBACK',
        recommendation: 'Ideal for static high-noise kitchen environments requiring physical noise immunity.'
      }
    ];
  }

  public async boot(): Promise<void> {
    log.info('Booting Local Hub Runtime...');

    // Load persisted devices from storage if available
    try {
      const persistedDevices = await storageEngine.get('network', 'devices');
      if (Array.isArray(persistedDevices) && persistedDevices.length > 0) {
        persistedDevices.forEach((node: DeviceNode) => {
          this.devices.set(node.id, node);
        });
      }
    } catch (e) {
      log.warn('Could not load persisted devices on boot');
    }

    // Initialize BroadcastChannel for cross-window / cross-tab local LAN mesh simulation
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        this.broadcastChannel = new BroadcastChannel('plugos_local_lan_mesh');
        this.broadcastChannel.onmessage = (msg) => this.handlePeerMessage(msg.data);
      }
    } catch (e) {
      log.warn('BroadcastChannel not available in this environment');
    }

    // Subscribe to event engine to route local events
    eventEngine.subscribe('*', async (event: KernelEvent) => {
      await this.handleLocalEvent(event);
    });

    // Start background heartbeat monitor loop
    setInterval(() => this.pulseHeartbeat(), 3000);

    log.info('Local Hub Runtime active. Authority initialized.');
    this.notifyListeners();
  }

  private handlePeerMessage(data: any) {
    if (!data || !data.type) return;

    if (data.type === 'HEARTBEAT') {
      this.updateNodeHeartbeat(data.deviceId, data.deviceNode);
    } else if (data.type === 'DISCOVER_NODES_REQUEST') {
      // Respond to LAN discovery request
      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage({
          type: 'HEARTBEAT',
          deviceId: 'HUB-SOWETO-PRIMARY',
          deviceNode: this.devices.get('HUB-SOWETO-PRIMARY')
        });
      }
    } else if (data.type === 'DEVICE_JOINED') {
      if (data.device && !this.devices.has(data.device.id)) {
        this.devices.set(data.device.id, data.device);
        storageEngine.set('network', 'devices', Array.from(this.devices.values())).catch(() => {});
        this.notifyListeners();
      }
    } else if (data.type === 'EVENT_BROADCAST') {
      const event: KernelEvent = data.event;
      if (!this.processedEventIds.has(event.eventId)) {
        this.processedEventIds.add(event.eventId);
        this.inbox.push(event);
        log.info(`Local Mesh received event ${event.eventId} (${event.action}) from peer.`);
        this.notifyListeners();
      }
    }
  }

  private updateNodeHeartbeat(deviceId: string, nodeData?: DeviceNode) {
    let node = this.devices.get(deviceId);
    if (!node && nodeData) {
      node = nodeData;
      this.devices.set(deviceId, node);
    }
    if (node) {
      node.lastHeartbeat = new Date().toISOString();
      node.status = 'ACTIVE';
      this.devices.set(deviceId, node);
      this.notifyListeners();
    }
  }

  private async handleLocalEvent(event: KernelEvent) {
    if (this.processedEventIds.has(event.eventId)) return;
    this.processedEventIds.add(event.eventId);

    // Add to outbox for cloud & local peer sync
    this.outbox.push(event);
    this.networkHealth.outboxDepth = this.outbox.length;

    // Broadcast across local LAN mesh
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'EVENT_BROADCAST',
        event
      });
    }

    log.info(`[Local Hub] Processed local event ${event.eventId} (${event.action})`);
    this.notifyListeners();
  }

  public pulseHeartbeat() {
    const now = Date.now();
    let activeCount = 0;

    this.devices.forEach((node) => {
      const lastSeen = new Date(node.lastHeartbeat).getTime();
      const diff = now - lastSeen;

      if (diff > 15000) {
        node.status = 'OFFLINE';
      } else if (diff > 7000) {
        node.status = 'DEGRADED';
      } else {
        node.status = 'ACTIVE';
        activeCount++;
      }
      this.devices.set(node.id, node);
    });

    this.networkHealth.localPeerCount = activeCount;

    // Send heartbeat outwards
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'HEARTBEAT',
        deviceId: 'HUB-SOWETO-PRIMARY',
        deviceNode: this.devices.get('HUB-SOWETO-PRIMARY')
      });
    }

    this.notifyListeners();
  }

  // --- Public Management APIs ---

  public getDevices(): DeviceNode[] {
    return Array.from(this.devices.values());
  }

  public getNetworkHealth(): NetworkHealth {
    return { ...this.networkHealth };
  }

  public getFailures(): FailureScenario[] {
    return [...this.simulatedFailures];
  }

  public getTransportMetrics(): SecondaryTransportMetric[] {
    return [...this.transportMetrics];
  }

  public getOutbox(): KernelEvent[] {
    return [...this.outbox];
  }

  public getInbox(): KernelEvent[] {
    return [...this.inbox];
  }

  public async registerDevice(device: Partial<DeviceNode>, options?: { branchId?: string; branchName?: string }): Promise<DeviceNode> {
    const devId = device.id || `DEV-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    const devName = device.name || 'New Local Terminal';
    const devRole = (device.role as DeviceNode['role']) || 'CASHIER';
    const branchId = options?.branchId || 'br-soweto';
    const branchName = options?.branchName || 'Soweto Central Township Hub';

    // Issue cryptographic Web Crypto certificate
    const cert = await certificateAuthority.issueCertificate({
      deviceId: devId,
      deviceName: devName,
      role: devRole,
      branchId,
      branchName
    });

    const newDevice: DeviceNode = {
      id: devId,
      name: devName,
      role: devRole,
      ipAddress: device.ipAddress || `192.168.1.10${this.devices.size + 1}`,
      status: 'ACTIVE',
      lastHeartbeat: new Date().toISOString(),
      latencyMs: 1.5,
      certFingerprint: cert.fingerprint,
      queuedEvents: 0,
      connectionType: device.connectionType || 'LAN_WIFI'
    };

    this.devices.set(newDevice.id, newDevice);
    log.info(`Device ${newDevice.id} (${newDevice.name}) registered to Local Hub with Cert ${cert.fingerprint.substring(0, 16)}`);
    
    await storageEngine.set('network', 'devices', Array.from(this.devices.values())).catch(err => {
      log.warn('Failed persisting devices to storage', err);
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'DEVICE_JOINED',
        device: newDevice,
        certificate: cert
      });
    }

    this.notifyListeners();
    return newDevice;
  }

  public revokeDevice(deviceId: string) {
    if (this.devices.has(deviceId)) {
      this.devices.delete(deviceId);
      certificateAuthority.revokeCertificate(deviceId).catch(() => {});
      log.info(`Device ${deviceId} revoked from Local Hub security registry.`);
      storageEngine.set('network', 'devices', Array.from(this.devices.values())).catch(err => {
        log.warn('Failed persisting devices after revoke', err);
      });
      this.notifyListeners();
    }
  }

  public toggleCloudStatus(online: boolean) {
    this.networkHealth.cloudConnected = online;
    if (online) {
      this.networkHealth.lastSyncTimestamp = new Date().toISOString();
      // Flush outbox
      this.outbox = [];
      this.networkHealth.outboxDepth = 0;
    }
    this.notifyListeners();
  }

  public triggerSubnetScan() {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({ type: 'DISCOVER_NODES_REQUEST' });
    }
    this.notifyListeners();
  }

  public runFailureSimulation(failureId: string) {
    // Disabled as per no simulations mandate.
  }

  public subscribe(listener: (state: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    const payload = {
      devices: this.getDevices(),
      networkHealth: this.getNetworkHealth(),
      failures: this.getFailures(),
      transportMetrics: this.getTransportMetrics(),
      outboxDepth: this.outbox.length,
      inboxDepth: this.inbox.length
    };
    this.listeners.forEach(fn => fn(payload));
  }
}

export const localHubRuntime = new LocalHubRuntime();
