import React, { useEffect, useState } from 'react';
import { AlertTriangle, Radio, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { NetworkHealth } from '@plugos/core';

interface DevicePairingWizardProps {
  kernel: any;
  onClose: () => void;
  branchName?: string;
  /** Retained for callers while the enrolled-device receiver is introduced. */
  branchId?: string;
  businessId?: string;
  sessionToken?: string;
}

/**
 * This surface intentionally does not create device records. A healthy native
 * runtime alone is not authorization: enrollment must be issued by the staged
 * cloud receiver and installed as a verified signed bundle on Android.
 */
export const DevicePairingWizard: React.FC<DevicePairingWizardProps> = ({
  kernel,
  onClose,
  branchName = 'Branch not configured',
}) => {
  const [health, setHealth] = useState<NetworkHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!kernel?.hub) return;

    const update = (snapshot?: { networkHealth?: NetworkHealth }) => {
      setHealth(snapshot?.networkHealth || kernel.hub.getNetworkHealth());
    };
    update();
    return kernel.hub.subscribe(update);
  }, [kernel]);

  const refresh = async () => {
    setError(null);
    try {
      await kernel?.network?.refresh?.();
      setHealth(kernel?.hub?.getNetworkHealth?.() || null);
    } catch (cause: any) {
      setError(cause?.message || 'The native Hub status could not be refreshed.');
    }
  };

  const nativeHubReady = health?.availability === 'READY';

  return (
    <div className="bg-slate-900 text-slate-100 rounded-2xl border border-slate-800 shadow-2xl max-w-xl w-full p-6 space-y-6 font-sans">
      <div className="flex items-start justify-between border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-400">
            <Radio className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Device enrollment</h2>
            <p className="text-xs text-slate-400">Native Hub authority • {branchName}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition" aria-label="Close device enrollment">
          <X className="w-5 h-5" />
        </button>
      </div>

      <section className={`rounded-xl border p-4 space-y-3 ${nativeHubReady ? 'border-amber-500/30 bg-amber-500/10' : 'border-rose-500/30 bg-rose-500/10'}`} aria-live="polite">
        <div className="flex gap-3">
          {nativeHubReady ? <ShieldCheck className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" /> : <AlertTriangle className="w-5 h-5 text-rose-300 shrink-0 mt-0.5" />}
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              {nativeHubReady ? 'Hub verified; enrollment receiver pending' : 'Native Cashier Hub required'}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-300">
              {nativeHubReady
                ? 'No pairing action is exposed yet. The Hub will accept a device only after the staged cloud receiver issues a signed authorization bundle and the Android runtime verifies it.'
                : (health?.message || 'This browser is not allowed to discover devices, issue certificates, or create pairing records.')}
            </p>
          </div>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          A device name, pairing code, or browser-generated certificate would not create authority. Those controls remain disabled until the complete native enrollment path has been staged and exercised.
        </p>
        <button type="button" onClick={refresh} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-xs font-medium text-slate-200 hover:bg-slate-800">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh Hub status
        </button>
      </section>

      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-100" role="alert">{error}</p>}
    </div>
  );
};
