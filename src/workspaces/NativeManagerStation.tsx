import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Cloud, CloudOff, Landmark, RefreshCw, ShieldCheck, WifiOff, XCircle } from 'lucide-react';
import { localHubRuntime } from '@plugos/core';
import type { NativeHubCancellableOrder, NativeHubCommandRequest, NativeHubOperatorContext, NetworkHealth } from '@plugos/core';

interface NativeManagerStationProps {
  onExit: () => void;
  onEndNativeSession: () => Promise<void>;
}

type PendingOpenShiftRequest = NativeHubCommandRequest;
type PendingCloseShiftRequest = NativeHubCommandRequest;
type PendingCancellationRequest = NativeHubCommandRequest & { orderId: string };
type ManagerCancellationTask = NativeHubCancellableOrder | { id: string; status: 'RECOVERY' };

interface ManagerCancellationQueueProps {
  tasks: ManagerCancellationTask[];
  pendingRequests: Record<string, PendingCancellationRequest>;
  cancellingOrderId: string | null;
  submitting: boolean;
  onCancel: (order: ManagerCancellationTask) => void;
  onAbandon: (order: ManagerCancellationTask) => void;
}

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

function parseMoney(value: string, label: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Enter a non-negative Rand amount with no more than two decimal places.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 999_999_999.99) throw new Error(`${label} is outside the supported local range.`);
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function recoveredOpenShiftRequest(context: NativeHubOperatorContext): PendingOpenShiftRequest | null {
  return (context.recoverableNativeCommands || []).find((command) => command.type === 'shift.open') || null;
}

function recoveredCloseShiftRequest(context: NativeHubOperatorContext): PendingCloseShiftRequest | null {
  return (context.recoverableNativeCommands || []).find((command) => command.type === 'shift.close') || null;
}

function recoveredCancellationRequests(context: NativeHubOperatorContext): Record<string, PendingCancellationRequest> {
  return (context.recoverableNativeCommands || []).reduce<Record<string, PendingCancellationRequest>>((requests, command) => {
    const orderId = command.payload.orderId;
    if (command.type !== 'order.status.transition' || typeof orderId !== 'string' || command.payload.status !== 'CANCELLED') {
      return requests;
    }
    if (requests[orderId] && requests[orderId].commandId !== command.commandId) {
      throw new Error(`The native Hub has more than one unresolved cancellation request for order ${orderId.slice(0, 8)}. Reconcile the measured native state before issuing another cancellation.`);
    }
    requests[orderId] = { ...command, orderId };
    return requests;
  }, {});
}

function requestShiftId(request: NativeHubCommandRequest): string {
  return typeof request.payload.shiftId === 'string' ? request.payload.shiftId : 'unknown';
}

const ManagerCancellationQueue: React.FC<ManagerCancellationQueueProps> = ({ tasks, pendingRequests, cancellingOrderId, submitting, onCancel, onAbandon }) => {
  if (tasks.length === 0) return null;
  const hasPendingRequest = Object.keys(pendingRequests).length > 0;
  return (
    <section className="space-y-3 rounded-2xl border border-rose-500/30 bg-slate-950 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-rose-200">Resolve pending orders</p>
        <h3 className="mt-1 text-lg font-black">Cancellation authority before close</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">These branch-scoped orders are still unpaid. A Manager may cancel only a locally `PLACED` or `PREPARING` order; native code verifies the state and restores the reserved stock atomically.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {tasks.map((order) => {
          const pendingCancellation = pendingRequests[order.id];
          const isCancelling = cancellingOrderId === order.id;
          return (
            <article key={order.id} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{order.status === 'RECOVERY' ? 'Retry reservation requires review' : `${order.status} · payment pending`}</span>
                  <strong className="mt-1 block text-sm text-slate-100">Order {order.id.slice(0, 8)}</strong>
                </div>
                <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-bold text-rose-100">{order.status === 'RECOVERY' ? 'REVIEW' : order.status}</span>
              </div>
              <button type="button" disabled={submitting} onClick={() => onCancel(order)} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs font-black text-rose-100 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"><XCircle className="h-3.5 w-3.5" aria-hidden="true" />{isCancelling ? 'Cancelling locally…' : pendingCancellation ? 'Retry the same cancellation request' : 'Cancel order locally'}</button>
              {pendingCancellation && <button type="button" disabled={submitting} onClick={() => onAbandon(order)} className="mt-2 w-full text-xs font-semibold text-amber-200 hover:text-amber-100">Abandon only if native confirms it never committed</button>}
            </article>
          );
        })}
      </div>
      {hasPendingRequest && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100">A native cancellation request is unresolved. It must be retried exactly or safely abandoned before the Hub will accept a close request.</p>}
    </section>
  );
};

/** Native Manager surface for cash custody. The native Hub derives expected
 * cash and records a physical count; this UI never declares a bank deposit,
 * cash-up approval, or cloud acknowledgement. */
export const NativeManagerStation: React.FC<NativeManagerStationProps> = ({ onExit, onEndNativeSession }) => {
  const [context, setContext] = useState<NativeHubOperatorContext | null>(null);
  const [health, setHealth] = useState<NetworkHealth | null>(null);
  const [openingFloat, setOpeningFloat] = useState('0.00');
  const [countedCash, setCountedCash] = useState('');
  const [pendingOpenRequest, setPendingOpenRequest] = useState<PendingOpenShiftRequest | null>(null);
  const [pendingCloseRequest, setPendingCloseRequest] = useState<PendingCloseShiftRequest | null>(null);
  const [pendingCancellationRequests, setPendingCancellationRequests] = useState<Record<string, PendingCancellationRequest>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [endingNativeSession, setEndingNativeSession] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshNativeState = useCallback(async () => {
    const [operator] = await Promise.all([
      localHubRuntime.getNativeOperatorContext(),
      localHubRuntime.refresh().catch(() => undefined),
    ]);
    setContext(operator);
    const recoveredOpen = recoveredOpenShiftRequest(operator);
    const recoveredClose = recoveredCloseShiftRequest(operator);
    if (recoveredOpen && recoveredClose) {
      throw new Error('The native Hub has unresolved opening and close requests. Reconcile the measured native state before issuing another cash-shift command.');
    }
    setPendingOpenRequest(recoveredOpen);
    setPendingCloseRequest(recoveredClose);
    setPendingCancellationRequests(recoveredCancellationRequests(operator));
    if (recoveredOpen && typeof recoveredOpen.payload.openingFloat === 'number') {
      setOpeningFloat(recoveredOpen.payload.openingFloat.toFixed(2));
    }
    if (recoveredClose && typeof recoveredClose.payload.countedCash === 'number') {
      setCountedCash(recoveredClose.payload.countedCash.toFixed(2));
    } else if (operator.activeCashShift) {
      setCountedCash((current) => current.trim() === '' ? operator.activeCashShift!.expectedCash.toFixed(2) : current);
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
    let request = pendingOpenRequest;
    try {
      if (!request) {
        const amount = parseMoney(openingFloat, 'The opening float');
        const shiftId = createRequestUuid();
        request = {
          commandId: createRequestUuid(),
          type: 'shift.open' as const,
          payload: { shiftId, openingFloat: amount },
        };
        setPendingOpenRequest(request);
      }
      const receipt = await localHubRuntime.submitNativeCommandRequest(request);
      setPendingOpenRequest(null);
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
    if (!pendingOpenRequest) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const discarded = await localHubRuntime.discardNativeCommandRequest(pendingOpenRequest.commandId);
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

  const closeShift = async () => {
    const activeShift = context?.activeCashShift;
    if (!activeShift) {
      setMessage('There is no measured open cash shift to close. Refresh the native Hub state before retrying.');
      return;
    }
    if (Object.keys(pendingCancellationRequests).length > 0) {
      setMessage('Resolve the preserved native cancellation request before closing this cash shift. Retry it exactly, or use the native-confirmed abandonment path.');
      return;
    }
    setSubmitting(true);
    setMessage(null);
    let request = pendingCloseRequest;
    try {
      if (!request) {
        const count = parseMoney(countedCash, 'The counted cash');
        request = {
          commandId: createRequestUuid(),
          type: 'shift.close' as const,
          payload: { shiftId: activeShift.id, countedCash: count },
        };
        setPendingCloseRequest(request);
      }
      const receipt = await localHubRuntime.submitNativeCommandRequest(request);
      setPendingCloseRequest(null);
      await refreshNativeState();
      setMessage(
        receipt.outcome === 'DUPLICATE'
          ? `The exact close request for shift ${requestShiftId(request).slice(0, 8)} was already committed locally; no second count or variance fact was written.`
          : `Cash shift ${requestShiftId(request).slice(0, 8)} was closed locally. ${receipt.outboxIds.length} event(s) remain queued until cloud acknowledgement if the link is unavailable.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The native Hub could not close this cash shift. The same request can be retried safely after review.');
    } finally {
      setSubmitting(false);
    }
  };

  const abandonPendingCloseShift = async () => {
    if (!pendingCloseRequest) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const discarded = await localHubRuntime.discardNativeCommandRequest(pendingCloseRequest.commandId);
      await refreshNativeState();
      setMessage(discarded
        ? 'The native Hub confirmed that this close request had no receipt and abandoned only its retry reservation. No count, variance, event, shift state, or outbox record was removed.'
        : 'That close request no longer has an uncommitted native reservation. The measured Hub state was refreshed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The native Hub could not safely abandon this close request.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelPendingOrder = async (order: ManagerCancellationTask) => {
    setCancellingOrderId(order.id);
    setSubmitting(true);
    setMessage(null);
    let request = pendingCancellationRequests[order.id];
    try {
      if (!request) {
        if (order.status !== 'PLACED' && order.status !== 'PREPARING') {
          throw new Error('This order is no longer eligible for a new Manager cancellation request. Refresh the measured Hub state.');
        }
        request = {
          commandId: createRequestUuid(),
          orderId: order.id,
          type: 'order.status.transition',
          payload: { orderId: order.id, status: 'CANCELLED' },
        };
        setPendingCancellationRequests((current) => ({ ...current, [order.id]: request }));
      }
      const receipt = await localHubRuntime.submitNativeCommandRequest(request);
      setPendingCancellationRequests((current) => {
        const next = { ...current };
        delete next[order.id];
        return next;
      });
      await refreshNativeState();
      setMessage(
        receipt.outcome === 'DUPLICATE'
          ? `The exact cancellation request for order ${order.id.slice(0, 8)} was already committed locally; no second cancellation transition was written.`
          : `Order ${order.id.slice(0, 8)} was cancelled locally. ${receipt.outboxIds.length} event(s) remain queued until cloud acknowledgement if the link is unavailable.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The native Hub could not cancel this order. The same request can be retried safely.');
    } finally {
      setCancellingOrderId(null);
      setSubmitting(false);
    }
  };

  const abandonPendingCancellation = async (order: ManagerCancellationTask) => {
    const request = pendingCancellationRequests[order.id];
    if (!request) return;
    setCancellingOrderId(order.id);
    setSubmitting(true);
    setMessage(null);
    try {
      const discarded = await localHubRuntime.discardNativeCommandRequest(request.commandId);
      await refreshNativeState();
      setMessage(discarded
        ? `The native Hub confirmed that the cancellation request for order ${order.id.slice(0, 8)} had no receipt and abandoned only its retry reservation. No cancellation event, order state, stock fact, audit fact, or outbox record was removed.`
        : 'That cancellation request no longer has an uncommitted native reservation. The measured Hub state was refreshed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The native Hub could not safely abandon this cancellation request.');
    } finally {
      setCancellingOrderId(null);
      setSubmitting(false);
    }
  };

  const endNativeSession = async () => {
    setEndingNativeSession(true);
    setMessage(null);
    try {
      await onEndNativeSession();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The native staff session could not be ended safely.');
    } finally {
      setEndingNativeSession(false);
    }
  };

  const cloudState = health?.cloudStatus || 'UNKNOWN';
  const cloudIcon = cloudState === 'CONNECTED' ? <Cloud className="h-4 w-4" aria-hidden="true" /> : <CloudOff className="h-4 w-4" aria-hidden="true" />;
  const activeShift = context?.activeCashShift || null;
  const cancellableOrders = context?.cancellableOrders || [];
  const cancellableOrderIds = new Set(cancellableOrders.map((order) => order.id));
  const cancellationTasks: ManagerCancellationTask[] = [
    ...cancellableOrders,
    ...Object.keys(pendingCancellationRequests)
      .filter((orderId) => !cancellableOrderIds.has(orderId))
      .map((id) => ({ id, status: 'RECOVERY' as const })),
  ];
  const hasPendingCancellation = Object.keys(pendingCancellationRequests).length > 0;
  const countedPreview = /^\d+(?:\.\d{1,2})?$/.test(countedCash.trim()) ? Number(countedCash) : null;
  const variancePreview = activeShift !== null && countedPreview !== null && Number.isFinite(countedPreview)
    ? Math.round((countedPreview - activeShift.expectedCash + Number.EPSILON) * 100) / 100
    : null;

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
          <button type="button" onClick={() => void endNativeSession()} disabled={endingNativeSession} className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-bold text-slate-100 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">End native staff session</button>
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
            <ManagerCancellationQueue tasks={cancellationTasks} pendingRequests={pendingCancellationRequests} cancellingOrderId={cancellingOrderId} submitting={submitting} onCancel={(order) => { void cancelPendingOrder(order); }} onAbandon={(order) => { void abandonPendingCancellation(order); }} />
            <div className="space-y-4 rounded-2xl border border-sky-500/30 bg-slate-950 p-4">
              <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-sky-200">Count and close</p><h3 className="mt-1 text-lg font-black">Record the physical drawer count</h3><p className="mt-1 text-sm leading-relaxed text-slate-400">The expected cash is measured from committed opening and capture facts. Enter the physical count; native code derives and records the final variance. The Hub rejects a close while this shift still has a pending order.</p></div>
              <label className="block text-sm font-semibold text-slate-200">Counted cash (ZAR)<input value={countedCash} inputMode="decimal" disabled={submitting || Boolean(pendingCloseRequest)} onChange={(event) => { setCountedCash(event.target.value); }} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-3 text-base text-slate-100 disabled:opacity-50" aria-describedby="counted-cash-hint" /></label>
              <p id="counted-cash-hint" className="text-xs leading-relaxed text-slate-500">Use a non-negative amount with at most two decimals. The preview is not a cash fact; the native Hub validates the measured shift again when it commits.</p>
              <div className={`rounded-xl border p-3 text-sm ${variancePreview === null ? 'border-slate-700 bg-slate-900 text-slate-400' : variancePreview === 0 ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : variancePreview > 0 ? 'border-sky-500/30 bg-sky-500/10 text-sky-100' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'}`}><strong className="block text-xs uppercase tracking-[0.12em]">Variance preview</strong><span className="mt-1 block font-black">{variancePreview === null ? 'Enter a valid count' : variancePreview === 0 ? 'Balanced · R 0.00' : `${variancePreview > 0 ? 'Over' : 'Short'} · ${money.format(Math.abs(variancePreview))}`}</span></div>
              <button type="button" disabled={submitting || cancellableOrders.length > 0 || hasPendingCancellation} onClick={() => void closeShift()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-300 px-4 py-3 text-sm font-black text-slate-950 hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-50"><Landmark className="h-4 w-4" aria-hidden="true" />{submitting ? 'Committing locally…' : pendingCloseRequest ? 'Retry the same close request' : 'Close cash shift locally'}</button>
              {pendingCloseRequest && <button type="button" disabled={submitting} onClick={() => void abandonPendingCloseShift()} className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs font-bold text-amber-100 hover:bg-amber-500/20 disabled:opacity-50">Abandon only if native confirms it never committed</button>}
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100"><strong>Cash-up approval and bank deposit remain unavailable.</strong> A local close records only the count and variance; it does not claim approval, deposit, printing, physical custody transfer, or cloud acknowledgement.</p>
            </div>
          </section>
        ) : (
          <section className="mx-auto max-w-xl space-y-5 rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <div><span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-100">Opening control</span><h2 className="mt-4 text-xl font-black">Open the branch cash shift</h2><p className="mt-2 text-sm leading-relaxed text-slate-400">The native Hub records one immutable opening float before a Cashier can create or capture a cash order.</p></div>
            <label className="block text-sm font-semibold text-slate-200">Opening float (ZAR)<input value={openingFloat} inputMode="decimal" disabled={submitting || Boolean(pendingOpenRequest)} onChange={(event) => { setOpeningFloat(event.target.value); }} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-base text-slate-100 disabled:opacity-50" aria-describedby="opening-float-hint" /></label>
            <p id="opening-float-hint" className="text-xs leading-relaxed text-slate-500">Use a non-negative amount with at most two decimals. The Hub signs and commits the final value; this field does not create browser authority.</p>
            <button type="button" disabled={submitting} onClick={() => void openShift()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-4 py-3 text-sm font-black text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"><Landmark className="h-4 w-4" aria-hidden="true" />{submitting ? 'Committing locally…' : pendingOpenRequest ? 'Retry the same opening request' : 'Open cash shift locally'}</button>
            {pendingOpenRequest && <button type="button" disabled={submitting} onClick={() => void abandonPendingOpenShift()} className="w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs font-bold text-amber-100 hover:bg-amber-500/20 disabled:opacity-50">Abandon only if native confirms it never committed</button>}
          </section>
        )}

        <div className="flex flex-wrap gap-3"><button type="button" onClick={() => void refreshNativeState().catch((error) => setMessage(error instanceof Error ? error.message : 'Native state could not be refreshed.'))} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-slate-800"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh measured Hub state</button><button type="button" onClick={() => void endNativeSession()} disabled={endingNativeSession || submitting} className="inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-500 hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-50"><WifiOff className="h-3.5 w-3.5" aria-hidden="true" />{endingNativeSession ? 'Ending native staff session…' : 'End native staff session'}</button></div>
      </div>
    </main>
  );
};
