import React, { useState, useEffect } from 'react';
import { 
  Wifi, 
  WifiOff, 
  Server, 
  Smartphone, 
  Monitor, 
  ShieldCheck, 
  AlertTriangle, 
  RefreshCw, 
  Cpu, 
  Layers, 
  Activity, 
  Zap, 
  Radio, 
  Database, 
  CheckCircle2, 
  XCircle, 
  Plus, 
  Trash2, 
  Play, 
  FileText 
} from 'lucide-react';
import { DeviceNode, NetworkHealth, FailureScenario, SecondaryTransportMetric } from '@plugos/core';

interface OfflineHubInspectorProps {
  kernel: any;
  onClose?: () => void;
}

export function OfflineHubInspector({ kernel, onClose }: OfflineHubInspectorProps) {
  const [activeTab, setActiveTab] = useState<'TOPOLOGY' | 'FAILURES' | 'TRANSPORTS' | 'LEDGER'>('TOPOLOGY');
  const [devices, setDevices] = useState<DeviceNode[]>([]);
  const [health, setHealth] = useState<NetworkHealth | null>(null);
  const [failures, setFailures] = useState<FailureScenario[]>([]);
  const [transports, setTransports] = useState<SecondaryTransportMetric[]>([]);
  const [outbox, setOutbox] = useState<any[]>([]);
  const [inbox, setInbox] = useState<any[]>([]);

  // Device registration modal form state
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceRole, setNewDeviceRole] = useState<'CASHIER' | 'KITCHEN_STAFF' | 'MANAGER' | 'OWNER'>('CASHIER');

  useEffect(() => {
    // Initial fetch
    if (kernel?.hub) {
      setDevices(kernel.hub.getDevices());
      setHealth(kernel.hub.getNetworkHealth());
      setFailures(kernel.hub.getFailures());
      setTransports(kernel.hub.getTransportMetrics());
      setOutbox(kernel.hub.getOutbox());
      setInbox(kernel.hub.getInbox());

      // Subscribe to real-time hub updates
      const unsubscribe = kernel.hub.subscribe((state: any) => {
        setDevices(state.devices);
        setHealth(state.networkHealth);
        setFailures(state.failures);
        setTransports(state.transportMetrics);
        setOutbox(kernel.hub.getOutbox());
        setInbox(kernel.hub.getInbox());
      });

      return () => unsubscribe();
    }
  }, [kernel]);

  const handleRegisterDevice = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeviceName.trim()) return;

    kernel.hub.registerDevice({
      name: newDeviceName,
      role: newDeviceRole,
      connectionType: 'LAN_WIFI'
    });

    setNewDeviceName('');
    setShowAddDevice(false);
  };

  const handleRevoke = (id: string) => {
    if (confirm(`Are you sure you want to revoke local certificate authorization for node ${id}?`)) {
      kernel.hub.revokeDevice(id);
    }
  };

  const handleRunSimulation = (id: string) => {
    kernel.hub.runSimulation(id);
  };

  return (
    <div className="bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-2xl overflow-hidden max-w-6xl mx-auto my-4">
      
      {/* Header Banner */}
      <div className="p-6 bg-slate-950 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-400">
              <Server className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold tracking-tight text-slate-100">
                  Constitutional Offline Infrastructure & Local Hub Inspector
                </h2>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                  Directive 009 Active
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Authority: Local Hub (192.168.1.100) • Zero-Cloud Dependency Operational Network
              </p>
            </div>
          </div>
        </div>

        {/* Global Network Health Bar */}
        <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 p-3 rounded-lg">
          <div className="text-right">
            <div className="text-xs text-slate-400 font-medium">WAN Cloud Status</div>
            <div className="flex items-center justify-end gap-1.5 mt-0.5">
              {health?.cloudConnected ? (
                <>
                  <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-xs font-semibold text-emerald-400">CLOUD SYNCED</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-xs font-semibold text-amber-400">OFFLINE CONTINUITY</span>
                </>
              )}
            </div>
          </div>

          <button
            onClick={() => kernel.network.setOnlineStatus(!health?.cloudConnected)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition ${
              health?.cloudConnected 
                ? 'bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20'
                : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20'
            }`}
          >
            {health?.cloudConnected ? 'Simulate Disconnect' : 'Reconnect Cloud'}
          </button>

          {onClose && (
            <button 
              onClick={onClose}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded transition"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Primary Navigation Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-950/60 px-6">
        <button
          onClick={() => setActiveTab('TOPOLOGY')}
          className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition ${
            activeTab === 'TOPOLOGY'
              ? 'border-amber-400 text-amber-400 bg-amber-400/5'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-4 h-4" />
          Mesh Network Topology ({devices.length} Nodes)
        </button>

        <button
          onClick={() => setActiveTab('FAILURES')}
          className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition ${
            activeTab === 'FAILURES'
              ? 'border-amber-400 text-amber-400 bg-amber-400/5'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
          Failure Certification Suite ({failures.length})
        </button>

        <button
          onClick={() => setActiveTab('TRANSPORTS')}
          className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition ${
            activeTab === 'TRANSPORTS'
              ? 'border-amber-400 text-amber-400 bg-amber-400/5'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Radio className="w-4 h-4" />
          Secondary Transports Evaluation
        </button>

        <button
          onClick={() => setActiveTab('LEDGER')}
          className={`flex items-center gap-2 px-4 py-3 text-xs font-medium border-b-2 transition ${
            activeTab === 'LEDGER'
              ? 'border-amber-400 text-amber-400 bg-amber-400/5'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Database className="w-4 h-4" />
          Local Event Ledger & Outbox ({outbox.length})
        </button>
      </div>

      {/* Main Tab Content */}
      <div className="p-6">
        {/* TAB 1: MESH NETWORK TOPOLOGY */}
        {activeTab === 'TOPOLOGY' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">Local Operational Network Registry</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Devices authenticated via shared SHA-256 branch certificate. Zero manual IP required.
                </p>
              </div>

              <button
                onClick={() => setShowAddDevice(!showAddDevice)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs rounded-lg transition"
              >
                <Plus className="w-3.5 h-3.5" />
                Authorize New Local Terminal
              </button>
            </div>

            {/* Add Device Form */}
            {showAddDevice && (
              <form onSubmit={handleRegisterDevice} className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-3">
                <h4 className="text-xs font-semibold text-amber-400">Auto-Discover & Register Local Terminal</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Terminal / Device Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Back counter POS 02"
                      value={newDeviceName}
                      onChange={(e) => setNewDeviceName(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Assigned Operational Role</label>
                    <select
                      value={newDeviceRole}
                      onChange={(e: any) => setNewDeviceRole(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                    >
                      <option value="CASHIER">CASHIER (POS Terminal)</option>
                      <option value="KITCHEN_STAFF">KITCHEN_STAFF (Kitchen KDS)</option>
                      <option value="MANAGER">MANAGER (Supervisor)</option>
                      <option value="OWNER">OWNER (Executive View)</option>
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddDevice(false)}
                    className="px-3 py-1 bg-slate-800 text-slate-300 text-xs rounded"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-3 py-1 bg-amber-500 text-slate-950 font-medium text-xs rounded hover:bg-amber-400"
                  >
                    Authenticate & Register
                  </button>
                </div>
              </form>
            )}

            {/* Device Nodes Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {devices.map((node) => (
                <div 
                  key={node.id}
                  className={`p-4 rounded-xl border transition ${
                    node.isHub 
                      ? 'bg-amber-500/10 border-amber-500/40' 
                      : node.status === 'ACTIVE' 
                        ? 'bg-slate-950 border-slate-800' 
                        : 'bg-slate-950/60 border-rose-500/40'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      {node.isHub ? (
                        <Server className="w-5 h-5 text-amber-400" />
                      ) : node.role === 'KITCHEN_STAFF' ? (
                        <Monitor className="w-5 h-5 text-indigo-400" />
                      ) : (
                        <Smartphone className="w-5 h-5 text-sky-400" />
                      )}
                      <div>
                        <div className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
                          {node.name}
                          {node.isHub && (
                            <span className="px-1.5 py-0.2 bg-amber-500 text-slate-950 text-[10px] font-extrabold rounded">
                              HUB
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono mt-0.5">{node.ipAddress}</div>
                      </div>
                    </div>

                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      node.status === 'ACTIVE' 
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : node.status === 'DEGRADED'
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                    }`}>
                      {node.status}
                    </span>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-800/80 grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <span className="text-slate-500 block">Role</span>
                      <span className="font-medium text-slate-300">{node.role}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Transport</span>
                      <span className="font-medium text-slate-300">{node.connectionType}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Latency</span>
                      <span className="font-mono text-emerald-400">{node.latencyMs} ms</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Certificate</span>
                      <span className="font-mono text-slate-400 text-[9px] truncate block" title={node.certFingerprint}>
                        {node.certFingerprint.substring(0, 14)}...
                      </span>
                    </div>
                  </div>

                  {!node.isHub && (
                    <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-end">
                      <button
                        onClick={() => handleRevoke(node.id)}
                        className="text-[10px] text-rose-400 hover:text-rose-300 flex items-center gap-1 transition"
                      >
                        <Trash2 className="w-3 h-3" />
                        Revoke Access
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 2: FAILURE CERTIFICATION SUITE */}
        {activeTab === 'FAILURES' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Constitutional Failure Recovery Certification</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Stress-test network partitions, router power cuts, and cloud dropouts. System recovers automatically without data loss.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {failures.map((f) => (
                <div key={f.id} className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-amber-400 font-bold">{f.id}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      f.status === 'IDLE' ? 'bg-slate-800 text-slate-400' :
                      f.status === 'SIMULATING' ? 'bg-amber-500/20 text-amber-400 animate-pulse' :
                      f.status === 'RECOVERING' ? 'bg-sky-500/20 text-sky-400' :
                      'bg-emerald-500/20 text-emerald-400'
                    }`}>
                      {f.status}
                    </span>
                  </div>

                  <h4 className="text-sm font-bold text-slate-100">{f.title}</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">{f.description}</p>

                  <div className="bg-slate-900/80 p-2.5 rounded border border-slate-800/80 text-[11px] space-y-1">
                    <div><span className="text-amber-400 font-medium">Impact:</span> {f.impact}</div>
                    <div><span className="text-emerald-400 font-medium">Recovery:</span> {f.recoveryMechanism}</div>
                  </div>

                  <button
                    onClick={() => handleRunSimulation(f.id)}
                    disabled={f.status !== 'IDLE' && f.status !== 'RESOLVED'}
                    className="w-full py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition disabled:opacity-50"
                  >
                    <Play className="w-3.5 h-3.5 text-amber-400" />
                    Execute Failure & Verify Auto-Recovery
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 3: SECONDARY TRANSPORTS EVALUATION */}
        {activeTab === 'TRANSPORTS' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Secondary Transport Protocol Evaluation Report</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Constitutional comparative study of fallback local communication channels for township deployments.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 bg-slate-950">
                    <th className="py-3 px-4 font-semibold">Transport Protocol</th>
                    <th className="py-3 px-4 font-semibold">Bandwidth</th>
                    <th className="py-3 px-4 font-semibold">Latency</th>
                    <th className="py-3 px-4 font-semibold">Battery</th>
                    <th className="py-3 px-4 font-semibold">Township Score</th>
                    <th className="py-3 px-4 font-semibold">Official Status</th>
                    <th className="py-3 px-4 font-semibold">Recommendation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 bg-slate-950/40">
                  {transports.map((t) => (
                    <tr key={t.name} className="hover:bg-slate-900/50">
                      <td className="py-3.5 px-4 font-bold text-slate-100 flex items-center gap-2">
                        <Radio className="w-4 h-4 text-amber-400" />
                        {t.name}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-300">{t.bandwidthMbps} Mbps</td>
                      <td className="py-3.5 px-4 font-mono text-slate-300">&lt; {t.maxLatencyMs} ms</td>
                      <td className="py-3.5 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          t.batteryImpact === 'LOW' ? 'text-emerald-400 bg-emerald-500/10' : 'text-amber-400 bg-amber-500/10'
                        }`}>
                          {t.batteryImpact}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 font-bold text-amber-400 font-mono">{t.townshipSuitabilityScore} / 10</td>
                      <td className="py-3.5 px-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          t.status === 'PRIMARY' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-slate-800 text-slate-300'
                        }`}>
                          {t.status}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-slate-400 max-w-xs">{t.recommendation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: EVENT LEDGER & OUTBOX */}
        {activeTab === 'LEDGER' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">Local Event Sourcing Outbox & Ledger</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Immutable event records queued locally in IndexedDB outbox. Flushed automatically on cloud connectivity.
                </p>
              </div>

              <div className="flex gap-2">
                <span className="px-3 py-1 bg-slate-950 border border-slate-800 rounded text-xs text-slate-300 font-mono">
                  Outbox: <strong className="text-amber-400">{outbox.length}</strong>
                </span>
                <span className="px-3 py-1 bg-slate-950 border border-slate-800 rounded text-xs text-slate-300 font-mono">
                  Inbox: <strong className="text-emerald-400">{inbox.length}</strong>
                </span>
              </div>
            </div>

            {outbox.length === 0 ? (
              <div className="text-center py-12 bg-slate-950 rounded-xl border border-slate-800 text-slate-500">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2 opacity-80" />
                <p className="text-xs font-medium text-slate-300">Outbox Queue Clear</p>
                <p className="text-[11px] text-slate-500 mt-0.5">All operational events synchronized locally & persisted to storage.</p>
              </div>
            ) : (
              <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 bg-slate-900/80">
                      <th className="py-3 px-4 font-semibold">Event ID</th>
                      <th className="py-3 px-4 font-semibold">Action</th>
                      <th className="py-3 px-4 font-semibold">Entity Type</th>
                      <th className="py-3 px-4 font-semibold">Timestamp</th>
                      <th className="py-3 px-4 font-semibold">Sync Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {outbox.map((evt, idx) => (
                      <tr key={evt.eventId || idx} className="hover:bg-slate-900/40">
                        <td className="py-3 px-4 text-amber-400">{evt.eventId?.substring(0, 16)}...</td>
                        <td className="py-3 px-4 font-sans font-semibold text-slate-200">{evt.action}</td>
                        <td className="py-3 px-4 text-slate-400">{evt.entityType}</td>
                        <td className="py-3 px-4 text-slate-400">{evt.timestamp}</td>
                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                            QUEUED_FOR_CLOUD
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
