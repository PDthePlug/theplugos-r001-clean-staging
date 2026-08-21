import React, { useEffect, useState } from 'react';
import { KeyRound, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { sdk } from '@plugos/sdk';
import { supabase } from '../lib/supabase';

interface NativeHubEnrollmentControlProps {
  businessId: string;
  branchId: string;
  branchName: string;
  compact?: boolean;
}

interface PairingCodeResponse {
  ok?: unknown;
  pairingCode?: unknown;
  expiresAt?: unknown;
}

/**
 * Owner-only bridge for a short-lived native Hub pairing code. The code stays
 * in component memory only: it is not copied to local storage, URL state, or
 * a browser-to-native plugin call. The Android activity asks the operator to
 * enter it directly on the device.
 */
export const NativeHubEnrollmentControl: React.FC<NativeHubEnrollmentControlProps> = ({
  businessId,
  branchId,
  branchName,
  compact = false,
}) => {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openingNative, setOpeningNative] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!code || !expiresAt) return undefined;
    const delay = Math.max(0, Date.parse(expiresAt) - Date.now());
    const timeout = window.setTimeout(() => {
      setCode(null);
      setExpiresAt(null);
      setMessage('The pairing code expired and was removed from this screen. Issue a new one if needed.');
    }, delay + 50);
    return () => window.clearTimeout(timeout);
  }, [code, expiresAt]);

  const issueCode = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const { data, error } = await supabase.functions.invoke('hub-owner-enrollment', {
        body: { action: 'issue-hub-pairing-code', businessId, branchId },
      });
      if (error) throw error;
      const result = data as PairingCodeResponse | null;
      if (!result || result.ok !== true || typeof result.pairingCode !== 'string' || !/^\d{6}$/.test(result.pairingCode) ||
          typeof result.expiresAt !== 'string' || Number.isNaN(Date.parse(result.expiresAt))) {
        throw new Error('The owner enrollment receiver returned an invalid result.');
      }
      setCode(result.pairingCode);
      setExpiresAt(result.expiresAt);
      setMessage(`Enter this short-lived code directly on the Android Cashier Hub for ${branchName}.`);
    } catch {
      setCode(null);
      setExpiresAt(null);
      setMessage('A pairing code could not be issued. Confirm that the staged owner enrollment receiver is deployed for this exact portal origin.');
    } finally {
      setLoading(false);
    }
  };

  const openNativeEnrollment = async () => {
    setOpeningNative(true);
    setMessage(null);
    try {
      await sdk.hub.openNativeEnrollment();
      setMessage('Native enrollment opened. Enter the code on the Android screen; it is never passed through the browser bridge.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The Android native enrollment screen could not be opened.');
    } finally {
      setOpeningNative(false);
    }
  };

  return (
    <section className={`rounded-2xl border border-slate-800 bg-slate-950 ${compact ? 'p-4' : 'p-5'} space-y-4`} aria-labelledby="native-hub-enrollment-title">
      <div className="flex items-start gap-3">
        <span className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-300"><Smartphone className="h-5 w-5" aria-hidden="true" /></span>
        <div>
          <h3 id="native-hub-enrollment-title" className="text-sm font-bold text-slate-100">Enroll this Android Cashier Hub</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            An owner can issue one six-digit code for {branchName}. The code is visible only here until expiry and must be entered directly into the native Hub screen.
          </p>
        </div>
      </div>

      {code && expiresAt && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4" aria-live="polite">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-200">One-time Hub code</span>
          <strong className="mt-1 block font-mono text-3xl tracking-[0.28em] text-amber-100">{code}</strong>
          <small className="mt-2 block text-xs text-amber-100/80">Expires {new Date(expiresAt).toLocaleTimeString()} on this device. Do not send or save this code.</small>
        </div>
      )}

      {message && <p className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs leading-relaxed text-slate-300" role="status">{message}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void issueCode()} disabled={loading || openingNative} className="inline-flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-950 hover:bg-white disabled:opacity-60">
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          {loading ? 'Issuing secure code…' : code ? 'Issue replacement code' : 'Issue Hub pairing code'}
        </button>
        <button type="button" onClick={() => void openNativeEnrollment()} disabled={openingNative || loading} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-100 hover:bg-slate-800 disabled:opacity-60">
          <Smartphone className="h-4 w-4" aria-hidden="true" />
          {openingNative ? 'Opening native Hub…' : 'Open native enrollment'}
        </button>
        {code && <button type="button" onClick={() => { setCode(null); setExpiresAt(null); setMessage('The code was removed from this browser screen.'); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-900">
          <Trash2 className="h-4 w-4" aria-hidden="true" /> Discard code
        </button>}
      </div>

      {!code && !loading && <p className="flex items-center gap-2 text-[11px] text-slate-500"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Issuing a replacement revokes the prior waiting code for this branch.</p>}
    </section>
  );
};
