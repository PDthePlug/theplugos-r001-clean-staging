import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Cloud, CloudOff, Landmark, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react';
import { localHubRuntime } from '@plugos/core';
import type { NativeHubCommandRequest, NativeHubOperatorContext, NetworkHealth } from '@plugos/core';

interface NativeManagerStationProps {
  onExit: () => void;
  onSignOut: () => void;
}

type PendingOpenShiftRequest = NativeHubCommandRequest;

const money = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });

function createRequestUuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues !== 'function') {
    throw new Error('This Android web runtime cannot create the required UUID request identifiers.');
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseMoney(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Enter a non-negative Rand amount with no more than two decimal places.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 999_999_999.99) throw new Error('The opening float is outside the supported local range.');
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function recoveredOpenShiftRequest(context: NativeHubOperatorContext): PendingOpenShiftRequest | null {
  return (context.recoverableNativeCommands || []).find((command) => command.type === 'shift.open') || null;
}

function requestShiftId(request: PendingOpenShiftRequest): string {
  return typeof request.payload.shiftId === 'string' ? request.payload.shiftId : 'unknown';
}

/** Native Manager surface for the first cash-custody command. It does not
 * invent shift close, cashup, approval, or variance workflows. */
export const NativeManagerStation: React.FC<NativeManagerStationProps> = ({ onExit, onSignOut }) => {
  const [context, setContext] = useState<NativeHubOperatorContext | null>(null);
  const [health, setHealth] = useState<NetworkHealth | null>(null);
  const [openingFloat, setOpeningFloat] = useState('0.00');
  const [pendingRequest, setPendingRequest] = useState<PendingOpenShiftRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshNativeState = useCallback(async () => {
    const [operator] = await Promise.all([
      localHubRuntime.getNativeOperatorContext(),
      localHubRuntime.refresh().catch(() => undefined),
    ]);
    setContext(operator);
    const recovered = recoveredOpenShiftRequest(operator);
    setPendingRequest(recovered);
    if (recovered && typeof recovered.payload.openingFloat === 'number') {
      setOpeningFloat(recovered.payload.openingFloat.toFixed(2));
    }
    setHealth(localHubRuntime.getNetworkHealth());
  }, []);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        await refreshNativeState();
        if (!mounted) return;
        unsubscribe = localHubRuntime.subscribe((snapshot) => {
          if (mounted) setHealth(snapshot.networkHealth);
        });
      } catch (error) {
        if (mounted) setMessage(error instanceof Error ? error.message : 'The native Manager station is unavailable.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [refreshNativeState]);

  const openShift = async () => {
    setSubmitting(true);
    setMessage(null);
    let request = pendingRequest;
    try {
      if (!request) {
        const amount = parseMoney(openingFloat);
        const shiftId = createRequestUuid();
        request = {
          commandId: createRequestUuid(),
          type: 'shift.open' as const,
          payload: { shiftId, openingFloat: amount },
        };
        setPendingRequest(request);
      }
      const receipt = await localHubRuntime.submitNativeCommandRequest(request);
      setPendingRequest(null);
      await refreshNativeState();
      setMessage(
        receipt.outcome === 'DUPLICATE'
          ? `The exact cash-shift request was already committed locally at ${new Date(receipt.committedAt).toLocaleTimeString()}; no second drawer was opened.`
          : `Cash shift ${requestShiftId(request).slice(0, 8)} is committed locally. ${receipt.outboxIds.length} event(s) await cloud acknowledgement if the cloud link is unavailable.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The native Hub could not open this cash shift. The same request can be retried safely after review.');
    } finally {
      setSubmitting(false);
    }
  };

  const abandonPendingOpenShift = async () => {
    if (!pendingRequest) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const discarded = await localHubRuntime.discardNativeCommandRequest(pendingRequest.commandId);
      await refreshNativeState();
      setMessage(discarded
        ? 'The native Hub confirmed that this opening request had no receipt and abandoned only its retry reservation. No shift, event, or outbox record was removed.'
        : 'That opening request no longer has an uncommitted native reservation. The measured Hub state was refreshed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The native Hub could not safely abandon this opening request.');
    } finally {
      setSubmitting(false);
    }
  };

  const cloudState = health?.cloudStatus || 'UNKNOWN';
  const cloudIcon = cloudState === 'CONNECTED' ? <Cloud className="h-4 w-4" aria-hidden="true" /> : <CloudOff className="h-4 w-4" aria-hidden="true" />;
  const activeShift = context?.activeCashShift || null;

  if (loading) {
    return <main className="min-h-screen bg-slate-950 p-6 text-slate-100"><p className="mx-auto max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-5 text-sm">Opening the measured native Manager station…</p></main>;
  }

  if (!context || context.role !== 'MANAGER') {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <section className="mx-auto max-w-lg space-y-5 rounded-3xl border border-amber-500/30 bg-slate-900 p-6">
          <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-100">Native role surface unavailable</span>
          <h1 className="text-xl font-bold">This active native session does not have a Manager cash-shift workspace.</h1>
          <p className="text-sm leading-relaxed text-slate-300">{message || 'Sign in as a Manager on the Android Hub. Cashier, Kitchen, Owner, and Administrator financial surfaces remain disabled until their own atomic command contracts are complete.'}</p>
          <button type="button" onClick={onExit} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-white">Return to native sign-in</button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 p-4 text-slate-100 md:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-slate-800 bg-slate-900 p-5 shadow-2xl">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onExit} className="rounded-xl border border-slate-700 bg-slate-950 p-2.5 text-slate-200 hover:bg-slate-800" aria-label="Return to native station access"><ArrowLeft className="h-5 w-5" /></button>
            <span className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-emerald-300"><ShieldCheck className="h-6 w-6" aria-hidden="true" /></span>
            <div><p className="text-xs uppercase tracking-[0.16em] text-slate-500">Native Manager Hub</p><h1 className="text-xl font-black">Cash custody · {context.staffName}</h1><p className="mt-0.5 text-xs text-slate-400">Measured local authority · no browser-held drawer state</p></div>
          </div>
          <div className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${cloudState === 'CONNECTED' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'}`}>
            {cloudIcon}<span><strong className="block">Cloud {cloudState.toLowerCase()}</strong><small className="block">{health?.outboxDepth || 0} locally committed event(s) awaiting acknowledgement</small></span>
          </div>
        </header>

        {message && <p className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-sm leading-relaxed text-slate-300" role="status">{message}</p>}

        {activeShift ? (
          <section className="space-y-4 rounded-3xl border border-emerald-500/30 bg-slate-900 p-6">
            <div className="flex items-center gap-3"><Landmark className="h-6 w-6 text-emerald-300" aria-hidden="true" /><div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-emerald-300">Cash shift open</p><h2 className="text-xl font-black">Drawer is locally accountable</h2></div></div>
            <dl className="grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-slate-800 bg-slate-950 p-4"><dt className="text-xs text-slate-500">Opening float</dt><dd className="mt-1 text-xl font-black">{money.format(activeShift.openingFloat)}</dd></div><div className="rounded-2xl border border-slate-800 bg-slate-950 p-4"><dt className="text-xs text-slate-500">Expected cash</dt><dd className="mt-1 text-xl font-black text-emerald-300">{money.format(activeShift.expectedCash)}</dd></div><div className="rounded-2xl border border-slate-800 bg-slate-950 p-4"><dt className="text-xs text-slate-500">Captured cash sales</dt><dd className="mt-1 text-lg font-bold">{money.format(activeShift.cashSalesTotal)}</dd></div><div className="rounded-2xl border border-slate-800 bg-slate-950 p-4"><dt className="text-xs text-slate-500">Change returned</dt><dd className="mt-1 text-lg font-bold">{money.format(activeShift.cashChangeTotal)}</dd></div></dl>
            <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-relaxed text-amber-100"><strong>Shift close and cashup are intentionally unavailable.</strong> This source milestone can open and measure a cash drawer; it does not fabricate a count, variance, approval, bank deposit, or close event.</p>
          </section>
        ) : (
          <section className="mx-auto max-w-xl space-y-5 rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <div><span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-100">Opening control</span><h2 className="mt-4 text-xl font-black">Open the branch cash shift</h2><p className="mt-2 text-sm leading-relaxed text-slate-400">The native Hub records one immutable opening float before a Cashier can create or capture a cash order.</p></div>
            <label className="block text-sm font-semibold text-slate-200">Opening float (ZAR)<input value={openingFloat} inputMode="decimal" disabled={submitting || Boolean(pendingRequest)} onChange={(event) => { setOpeningFloat(event.target.value); }} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-base text-slate-100 disabled:opacity-50" aria-describedby="opening-float-hint" /></label>
            <p id="opening-float-hint" className="text-xs leading-relaxed text-slate-500">Use a non-negative amount with at most two decimals. The Hub signs and commits the final value; this field does not create browser authority.</p>
            <button type="button" disabled={submitting} onClick={() => void openShift()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-4 py-3 text-sm font-black text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"><Landmark className="h-4 w-4" aria-hidden="true" />{submitting ? 'Committing locally…' : pendingRequest ? 'Retry the same opening request' : 'Open cash shift locally'}</button>
            {pendingRequest && <button type="button" disabled={submitting} onClick={() => void abandonPendingOpenShift()} className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs font-bold text-amber-100 hover:bg-amber-500/20 disabled:opacity-50">Abandon only if native confirms it never committed</button>}
          </section>
        )}

        <div className="flex flex-wrap gap-3"><button type="button" onClick={() => void refreshNativeState().catch((error) => setMessage(error instanceof Error ? error.message : 'Native state could not be refreshed.'))} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-slate-800"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh measured Hub state</button><button type="button" onClick={onSignOut} className="inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-500 hover:text-slate-300"><WifiOff className="h-3.5 w-3.5" aria-hidden="true" />Return to owner browser shell</button></div>
      </div>
    </main>
  );
};
