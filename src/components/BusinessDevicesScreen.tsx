import React, { useState, useEffect } from 'react';
import { 
  Smartphone, 
  Tv, 
  ShieldCheck, 
  Printer, 
  CheckCircle2, 
  Plus, 
  Radio, 
  RefreshCw, 
  Wifi, 
  WifiOff, 
  AlertCircle,
  X,
  Trash2,
  KeyRound,
  Edit2,
  Power,
  Clock,
  Ban
} from 'lucide-react';
import { DevicePairingWizard } from './DevicePairingWizard';
import { createDevicePairingCode, revokeDevice } from '../lib/security';
import { supabase } from '../lib/supabase';

interface DeviceRecord {
  id?: string;
  device_id: string;
  business_id: string;
  branch_id: string;
  device_name?: string;
  name?: string;
  device_type?: string;
  type?: string;
  status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  last_seen?: string;
  ip_address?: string;
}

interface BusinessDevicesScreenProps {
  kernel: any;
  onClose?: () => void;
  branchName?: string;
  businessId: string;
  branchId: string;
  userRole?: string;
  sessionToken?: string;
}

export const BusinessDevicesScreen: React.FC<BusinessDevicesScreenProps> = ({
  kernel,
  onClose,
  branchName = 'Branch not configured',
  businessId,
  branchId,
  userRole,
  sessionToken
}) => {
  const [showPairingWizard, setShowPairingWizard] = useState(false);
  const [testPrintStatus, setTestPrintStatus] = useState<string | null>(null);
  
  // Persistent Device state
  const [repoDevices, setRepoDevices] = useState<DeviceRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Pairing Code Modal State
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [expiresAtIso, setExpiresAtIso] = useState<string | null>(null);
  const [timeLeftSeconds, setTimeLeftSeconds] = useState<number>(0);
  const [showCodeModal, setShowCodeModal] = useState<boolean>(false);

  // Edit Device Name Modal
  const [editingDevice, setEditingDevice] = useState<DeviceRecord | null>(null);
  const [newDeviceName, setNewDeviceName] = useState('');

  // Load active devices from Supabase
  const loadDevices = async () => {
    if (!businessId) return;
    try {
      if (supabase) {
        const { data, error } = await supabase
          .from('devices')
          .select('*')
          .eq('business_id', businessId)
          .order('last_seen', { ascending: false });

        if (!error && data) {
          setRepoDevices(data as DeviceRecord[]);
        }
      }
    } catch (e) {
      console.warn('[DEVICES_LOAD_ERROR]', e);
    }
  };

  useEffect(() => {
    loadDevices();
    const interval = setInterval(loadDevices, 5000);
    return () => clearInterval(interval);
  }, [businessId]);

  // Timer countdown for active pairing code
  useEffect(() => {
    if (!activeCode || !expiresAtIso) {
      setTimeLeftSeconds(0);
      return;
    }

    const calculateTimeLeft = () => {
      const expiresAt = new Date(expiresAtIso).getTime();
      const now = Date.now();
      const diff = Math.max(0, Math.floor((expiresAt - now) / 1000));
      setTimeLeftSeconds(diff);
    };

    calculateTimeLeft();
    const timer = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(timer);
  }, [activeCode, expiresAtIso]);

  // Generate 6-Digit Pairing Code via R002 RPC
  const handleGeneratePairingCode = async () => {
    setErrorMsg(null);
    if (!sessionToken || (userRole !== 'OWNER' && userRole !== 'MANAGER')) {
      setErrorMsg('Unauthorized: Operational device administration requires an active OWNER or MANAGER session token.');
      return;
    }
    try {
      const res = await createDevicePairingCode(businessId, branchId, sessionToken);
      const generatedCode = res.code || res.pairing_code;
      if (res.success && generatedCode) {
        setActiveCode(generatedCode);
        setExpiresAtIso(res.expires_at || res.expiresAt || new Date(Date.now() + 10 * 60 * 1000).toISOString());
        setShowCodeModal(true);
      } else {
        setErrorMsg(res.error || 'Failed to generate enrollment code.');
      }
    } catch (e: any) {
      setErrorMsg(e.message || 'Error creating enrollment code.');
    }
  };

  const handleCloseCodeModal = () => {
    setActiveCode(null);
    setExpiresAtIso(null);
    setShowCodeModal(false);
  };

  const handleRemoveDevice = async (dev: DeviceRecord) => {
    if (!sessionToken || (userRole !== 'OWNER' && userRole !== 'MANAGER')) {
      setErrorMsg('Unauthorized: Operational device revocation requires an active OWNER or MANAGER session token.');
      return;
    }
    if (confirm(`Revoke device "${dev.name || dev.device_name || dev.device_id}"? It will lose network access immediately.`)) {
      setErrorMsg(null);
      const res = await revokeDevice(businessId, dev.device_id, sessionToken);
      if (res.success) {
        await loadDevices();
      } else {
        setErrorMsg(res.error || 'Failed to revoke device access.');
      }
    }
  };

  const handleToggleDeviceStatus = async (dev: DeviceRecord) => {
    if (dev.status === 'ACTIVE') {
      await handleRemoveDevice(dev);
    } else if (supabase) {
      await supabase.from('devices').update({ status: 'ACTIVE' }).eq('device_id', dev.device_id);
      await loadDevices();
    }
  };

  const handleSaveRename = async () => {
    if (editingDevice && newDeviceName.trim()) {
      if (supabase) {
        await supabase
          .from('devices')
          .update({ name: newDeviceName.trim(), device_name: newDeviceName.trim() })
          .eq('device_id', editingDevice.device_id);
      }
      setEditingDevice(null);
      setNewDeviceName('');
      await loadDevices();
    }
  };

  const handleTestPrint = () => {
    setTestPrintStatus('Printing test receipt...');
    setTimeout(() => {
      setTestPrintStatus('Test receipt printed successfully on Thermal Printer #1!');
      setTimeout(() => setTestPrintStatus(null), 3500);
    }, 1200);
  };

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-slate-100 max-w-4xl mx-auto shadow-2xl space-y-6">
      
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-xl">
            <Radio className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Business Devices ({repoDevices.length})</h2>
            <p className="text-xs text-slate-400">
              Active shop devices, kitchen screens & printers • {branchName}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleGeneratePairingCode}
            className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-2 transition shadow-lg cursor-pointer"
          >
            <KeyRound className="w-4 h-4" /> Generate 6-Digit Pairing Code
          </button>

          <button
            onClick={() => setShowPairingWizard(true)}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl flex items-center gap-1.5 transition"
          >
            <Plus className="w-4 h-4" /> Advanced Pairing
          </button>
          
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-xl transition"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Network Overview Card */}
      <div className="p-4 bg-slate-950 border border-slate-800 rounded-2xl grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
        <div className="space-y-1">
          <div className="text-slate-400">Business Network</div>
          <div className="font-bold text-emerald-400 flex items-center gap-1.5 text-sm">
            <CheckCircle2 className="w-4 h-4" /> Healthy ({repoDevices.filter(d => d.status === 'ACTIVE').length} Active Devices)
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-slate-400">Pairing Security</div>
          <div className="font-bold text-amber-400 text-sm">
            Single-Use 6-Digit Code (5m Expiry)
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-slate-400">Device Registry</div>
          <div className="font-bold text-slate-200 text-sm">
            Persistent Store (IndexedDB)
          </div>
        </div>
      </div>

      {/* Test Print Alert Banner */}
      {testPrintStatus && (
        <div className="p-3 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 rounded-xl flex items-center gap-2 text-xs font-semibold animate-fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          {testPrintStatus}
        </div>
      )}

      {/* Device List Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {repoDevices.map((dev) => {
          const isPrinter = dev.device_type === 'PRINTER';
          const isKitchen = dev.device_type === 'KITCHEN' || dev.device_type === 'KITCHEN_STAFF';
          const isManager = dev.device_type === 'MANAGER';
          const isOwner = dev.device_type === 'OWNER';
          const IconComp = isPrinter ? Printer : isKitchen ? Tv : isManager || isOwner ? ShieldCheck : Smartphone;

          return (
            <div
              key={dev.device_id}
              className={`p-4 bg-slate-950 border rounded-xl flex items-center justify-between transition ${
                dev.status === 'ACTIVE' ? 'border-slate-800 hover:border-slate-700' : 'border-rose-900/50 bg-rose-950/10'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2.5 border rounded-xl ${
                  dev.status === 'ACTIVE' 
                    ? 'bg-slate-900 border-slate-800 text-emerald-400' 
                    : 'bg-rose-950/40 border-rose-800 text-rose-400'
                }`}>
                  <IconComp className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-bold text-white flex items-center gap-1.5">
                    {dev.device_name}
                    <button
                      onClick={() => {
                        setEditingDevice(dev);
                        setNewDeviceName(dev.device_name);
                      }}
                      className="p-1 text-slate-500 hover:text-white transition"
                      title="Rename device"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5 font-mono">
                    Type: <span className="text-amber-400">{dev.device_type}</span> • ID: {dev.device_id.slice(0, 10)}
                  </div>
                  <div className="text-[9px] text-slate-500 flex items-center gap-1 mt-0.5">
                    <Clock className="w-2.5 h-2.5" /> Last seen: {new Date(dev.last_seen).toLocaleTimeString()}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                {isPrinter && (
                  <button
                    onClick={handleTestPrint}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-[10px] font-bold transition flex items-center gap-1"
                  >
                    <Printer className="w-3 h-3 text-emerald-400" /> Test
                  </button>
                )}

                <button
                  onClick={() => handleToggleDeviceStatus(dev)}
                  className={`px-2 py-1 rounded-lg text-[10px] font-bold font-mono flex items-center gap-1 cursor-pointer transition ${
                    dev.status === 'ACTIVE'
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-rose-500/20 hover:text-rose-300'
                      : 'bg-rose-500/10 text-rose-400 border border-rose-500/30 hover:bg-emerald-500/20 hover:text-emerald-300'
                  }`}
                  title={dev.status === 'ACTIVE' ? 'Click to Disable Device' : 'Click to Enable Device'}
                >
                  <Power className="w-3 h-3" /> {dev.status}
                </button>

                <button
                  onClick={() => handleRemoveDevice(dev)}
                  title="Remove device"
                  className="p-1.5 bg-slate-900 hover:bg-rose-950/50 text-slate-500 hover:text-rose-400 border border-slate-800 hover:border-rose-800 rounded-lg transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 6-Digit Pairing Code Display Modal (Phase 4) */}
      {showCodeModal && activeCode && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl space-y-6 text-center">
            
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-amber-500" />
                <h3 className="text-base font-bold text-white">Device Pairing</h3>
              </div>
              <button 
                onClick={handleCloseCodeModal}
                className="p-1 text-slate-400 hover:text-white rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-slate-300">
                Enter this code on the second device at the <span className="font-bold text-white">"Join Existing Business"</span> screen to authorize enrollment.
              </p>
            </div>

            <div className="p-6 bg-slate-950 border-2 border-amber-500/40 rounded-2xl space-y-3 shadow-inner">
              <span className="text-xs font-bold text-amber-400 uppercase tracking-widest block">Pair Code</span>
              <div className="text-5xl font-mono font-black tracking-[0.4em] text-amber-400 text-center pl-4">
                {activeCode}
              </div>
            </div>

            <div className="flex items-center justify-center gap-2 text-xs font-bold text-slate-300">
              <Clock className="w-4 h-4 text-amber-500 animate-pulse" />
              <span>Expires in</span>
              <span className="font-mono text-amber-400 text-sm">{formatCountdown(timeLeftSeconds)}</span>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCloseCodeModal}
                className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition"
              >
                Close
              </button>
              <button
                onClick={handleGeneratePairingCode}
                className="flex-1 py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl transition shadow-md"
              >
                Regenerate
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Rename Device Modal */}
      {editingDevice && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-sm w-full space-y-4">
            <h3 className="text-sm font-bold text-white">Rename Device</h3>
            <input
              type="text"
              value={newDeviceName}
              onChange={(e) => setNewDeviceName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
              placeholder="e.g. Kitchen Tablet"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setEditingDevice(null)}
                className="flex-1 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-bold"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveRename}
                className="flex-1 py-2 bg-amber-500 text-slate-950 rounded-xl text-xs font-bold"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Advanced Pairing Wizard Modal */}
      {showPairingWizard && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <DevicePairingWizard
            kernel={kernel}
            branchName={branchName}
            businessId={businessId}
            branchId={branchId}
            sessionToken={sessionToken}
            onClose={() => setShowPairingWizard(false)}
          />
        </div>
      )}

    </div>
  );
};

