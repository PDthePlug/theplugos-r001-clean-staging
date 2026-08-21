import React, { useState, useEffect } from 'react';
import { syncService, SyncStatus, SyncLogEntry } from '../services/SyncService';
import { 
  Activity, 
  Wifi, 
  WifiOff, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle, 
  X, 
  ShieldCheck, 
  Radio, 
  Clock, 
  Layers,
  ArrowUpRight,
  ArrowDownLeft,
  Share2
} from 'lucide-react';

interface SyncDiagnosticsModalProps {
  onClose: () => void;
}

export const SyncDiagnosticsModal: React.FC<SyncDiagnosticsModalProps> = ({ onClose }) => {
  const [status, setStatus] = useState<SyncStatus>(syncService.getStatus());
  const [realtimeStatus, setRealtimeStatus] = useState<string>(syncService.getRealtimeStatus());
  const [logs, setLogs] = useState<SyncLogEntry[]>(syncService.getLogs());
  const [deviceId] = useState<string>(localStorage.getItem('plugos_device_id') || 'dev-unknown');
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const unsubscribe = syncService.subscribe({
      onStatusChanged: (s) => {
        setStatus(s);
        setRealtimeStatus(syncService.getRealtimeStatus());
      },
      onLogAdded: (log) => setLogs(prev => [log, ...prev.slice(0, 99)])
    });
    return () => unsubscribe();
  }, []);

  const handleManualSync = async () => {
    setIsRefreshing(true);
    await syncService.fetchAndSyncOrders();
    await syncService.fetchAndSyncProducts();
    await syncService.fetchAndSyncStaff();
    setLogs(syncService.getLogs());
    setIsRefreshing(false);
  };

  const getStatusBadge = (s: SyncStatus) => {
    switch (s) {
      case 'SYNCED':
        return (
          <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1 rounded-full text-xs font-mono font-bold flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" /> SYNCED
          </span>
        );
      case 'SYNCING':
        return (
          <span className="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-3 py-1 rounded-full text-xs font-mono font-bold flex items-center gap-1.5 animate-pulse">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> SYNCING...
          </span>
        );
      case 'OFFLINE':
        return (
          <span className="bg-slate-800 text-slate-400 border border-slate-700 px-3 py-1 rounded-full text-xs font-mono font-bold flex items-center gap-1.5">
            <WifiOff className="w-3.5 h-3.5" /> OFFLINE
          </span>
        );
      case 'ERROR':
        return (
          <span className="bg-rose-500/10 text-rose-400 border border-rose-500/30 px-3 py-1 rounded-full text-xs font-mono font-bold flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> SYNC ERROR
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-2xl w-full shadow-2xl space-y-5 text-slate-100 max-h-[90vh] flex flex-col">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-xl">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                Sync & recovery details
              </h3>
              <p className="text-xs text-slate-400">
                See what this device has saved and what still needs to be shared.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white bg-slate-800 rounded-xl"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-950 p-4 border border-slate-800 rounded-2xl">
          <div>
            <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">Sync Status</span>
            <div className="mt-1">{getStatusBadge(status)}</div>
          </div>

          <div>
            <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">Device ID</span>
            <span className="text-xs font-mono font-bold text-amber-400 truncate block mt-1">
              {deviceId}
            </span>
          </div>

          <div>
            <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">Realtime Stream</span>
            <span className={`text-xs font-mono font-bold block mt-1 flex items-center gap-1 ${
              realtimeStatus === 'SUBSCRIBED' ? 'text-emerald-400' :
              realtimeStatus === 'CONNECTING' ? 'text-amber-400 animate-pulse' :
              'text-rose-400'
            }`}>
              <Radio className="w-3.5 h-3.5" /> {realtimeStatus}
            </span>
          </div>

          <div>
            <span className="text-[10px] text-slate-400 uppercase font-bold tracking-wider block">Sync Logs</span>
            <span className="text-xs font-mono font-bold text-slate-200 block mt-1">
              {logs.length} Operations
            </span>
          </div>
        </div>

        {/* Action button */}
        <div className="flex justify-between items-center">
          <span className="text-xs font-bold text-slate-400 flex items-center gap-1">
            <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" /> Recent movements
          </span>
          <button
            onClick={handleManualSync}
            disabled={isRefreshing}
            className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl flex items-center gap-1.5 transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} /> Sync now
          </button>
        </div>

        {/* Log Entries Stream */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[220px]">
          {logs.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-xs font-mono border border-slate-800/60 rounded-2xl bg-slate-950/40">
              No sync events logged yet in current session. Perform an order or product action to observe live propagation.
            </div>
          ) : (
            logs.map(log => (
              <div
                key={log.id}
                className="p-3 bg-slate-950 border border-slate-800/80 rounded-xl text-xs font-mono flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  {log.direction === 'UP' ? (
                    <ArrowUpRight className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : log.direction === 'DOWN' ? (
                    <ArrowDownLeft className="w-4 h-4 text-blue-400 shrink-0" />
                  ) : (
                    <Share2 className="w-4 h-4 text-amber-400 shrink-0" />
                  )}
                  <span className="font-bold text-slate-200 uppercase">{log.entityType}</span>
                  <span className="text-slate-500">•</span>
                  <span className="text-amber-400 font-semibold">{log.operation}</span>
                  <span className="text-slate-500 truncate hidden sm:inline">[{log.entityId}]</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-slate-500">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    log.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                  }`}>
                    {log.status}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 pt-3 flex items-center justify-between text-[11px] text-slate-500">
          <span>Current business only</span>
          <span>Local copy + secure cloud backup</span>
        </div>

      </div>
    </div>
  );
};
