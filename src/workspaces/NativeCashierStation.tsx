import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Cloud, CloudOff, Minus, Plus, ReceiptText, RefreshCw, ShieldCheck, ShoppingBasket, WifiOff } from 'lucide-react';
import { localHubRuntime } from '@plugos/core';
import type { NativeHubCommandRequest, NativeHubOperatorContext, NetworkHealth } from '@plugos/core';

interface NativeCashierStationProps {
  onExit: () => void;
  onSignOut: () => void;
}

type BasketLine = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
};

type PendingRequest = NativeHubCommandRequest & { orderId: string };

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

/**
 * First genuine cashier slice. Every menu value comes from the signed Hub
 * snapshot and every order moves through the native command request bridge;
 * there is no direct browser Supabase mutation or local-array order authority.
 */
export const NativeCashierStation: React.FC<NativeCashierStationProps> = ({ onExit, onSignOut }) => {
  const [context, setContext] = useState<NativeHubOperatorContext | null>(null);
  const [health, setHealth] = useState<NetworkHealth | null>(null);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [search, setSearch] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD' | 'SPAZAPAY_QR'>('CASH');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refreshNativeState = useCallback(async () => {
    const [operator] = await Promise.all([
      localHubRuntime.getNativeOperatorContext(),
      localHubRuntime.refresh().catch(() => undefined),
    ]);
    setContext(operator);
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
        if (mounted) setMessage(error instanceof Error ? error.message : 'The native operator station is unavailable.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [refreshNativeState]);

  const products = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (context?.catalogProducts || []).filter((product) =>
      !term || product.name.toLowerCase().includes(term) || product.category.toLowerCase().includes(term)
    );
  }, [context?.catalogProducts, search]);
  const subtotal = basket.reduce((total, line) => total + line.price * line.quantity, 0);
  const tax = context?.vat.enabled ? subtotal * (context.vat.rate / 100) : 0;
  const total = subtotal + tax;

  const addProduct = (product: NonNullable<NativeHubOperatorContext>['catalogProducts'][number]) => {
    setPendingRequest(null);
    // This first cashier slice has whole-unit touch controls. The native Hub
    // remains authoritative and rechecks the exact signed decimal balance,
    // but the UI should not knowingly construct an impossible reservation.
    const maximumWholeUnits = Math.floor(Math.max(0, product.stockQuantity));
    setBasket((current) => {
      const found = current.find((line) => line.productId === product.id);
      if (maximumWholeUnits < 1 || (found && found.quantity >= maximumWholeUnits)) return current;
      return found
        ? current.map((line) => line.productId === product.id ? { ...line, quantity: line.quantity + 1 } : line)
        : [...current, { productId: product.id, name: product.name, price: product.price, quantity: 1 }];
    });
  };

  const changeQuantity = (productId: string, change: number) => {
    setPendingRequest(null);
    const product = context?.catalogProducts.find((candidate) => candidate.id === productId);
    const maximumWholeUnits = product ? Math.floor(Math.max(0, product.stockQuantity)) : null;
    setBasket((current) => current.flatMap((line) => {
      if (line.productId !== productId) return [line];
      if (change > 0 && (maximumWholeUnits === null || maximumWholeUnits < line.quantity)) return [line];
      const quantity = change > 0
        ? Math.min(line.quantity + change, maximumWholeUnits ?? line.quantity)
        : line.quantity + change;
      return quantity > 0 ? [{ ...line, quantity }] : [];
    }));
  };

  const buildRequest = (): PendingRequest => {
    if (!context || basket.length === 0) throw new Error('Add at least one signed catalog item before creating an order.');
    const orderId = createRequestUuid();
    return {
      commandId: createRequestUuid(),
      orderId,
      type: 'order.create',
      payload: {
        orderId,
        items: basket.map((line) => ({
          productId: line.productId,
          name: line.name,
          price: line.price,
          quantity: line.quantity,
        })),
        subtotal: roundMoney(subtotal),
        tax: roundMoney(tax),
        totalAmount: roundMoney(total),
        paymentMethod,
        paymentType: paymentMethod,
      },
    };
  };

  const submit = async (request: PendingRequest) => {
    setSubmitting(true);
    setMessage(null);
    try {
      const receipt = await localHubRuntime.submitNativeCommandRequest(request);
      setPendingRequest(null);
      setBasket([]);
      await refreshNativeState();
      setMessage(
        receipt.outcome === 'DUPLICATE'
          ? `The exact request was already committed locally at ${new Date(receipt.committedAt).toLocaleTimeString()}; no second order was created.`
          : `Order ${request.orderId.slice(0, 8)} was committed locally with its signed stock reservation. ${receipt.outboxIds.length} event(s) await cloud acknowledgement if the cloud link is unavailable.`
      );
    } catch (error) {
      setPendingRequest(request);
      setMessage(error instanceof Error ? error.message : 'The native Hub could not commit this order. The same request can be retried safely.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitCurrentOrder = async () => {
    try {
      await submit(pendingRequest || buildRequest());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The order request could not be prepared.');
    }
  };

  const cloudState = health?.cloudStatus || 'UNKNOWN';
  const peerTransportActive = health?.activeTransport === 'LAN_WIFI';
  const cloudIcon = cloudState === 'CONNECTED' ? <Cloud className="h-4 w-4" aria-hidden="true" /> : <CloudOff className="h-4 w-4" aria-hidden="true" />;

  if (loading) {
    return <main className="min-h-screen bg-slate-950 p-6 text-slate-100"><p className="mx-auto max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-5 text-sm">Opening the measured native Hub station…</p></main>;
  }

  if (!context || context.role !== 'CASHIER') {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-slate-100">
        <section className="mx-auto max-w-lg space-y-5 rounded-3xl border border-amber-500/30 bg-slate-900 p-6">
          <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-100">Native role surface unavailable</span>
          <h1 className="text-xl font-bold">This active native session does not have a Cashier workspace yet.</h1>
          <p className="text-sm leading-relaxed text-slate-300">{message || 'Sign in as a Cashier on the Android Hub. Kitchen, Manager, Owner, and Administrator operational surfaces remain disabled until their own atomic command contracts are complete.'}</p>
          <button type="button" onClick={onExit} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-white">Return to native sign-in</button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 p-4 text-slate-100 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-slate-800 bg-slate-900 p-5 shadow-2xl">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onExit} className="rounded-xl border border-slate-700 bg-slate-950 p-2.5 text-slate-200 hover:bg-slate-800" aria-label="Return to native station access"><ArrowLeft className="h-5 w-5" /></button>
            <span className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-emerald-300"><ShieldCheck className="h-6 w-6" aria-hidden="true" /></span>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Native Cashier Hub</p>
              <h1 className="text-xl font-black">Hello, {context.staffName}</h1>
              <p className="mt-0.5 text-xs text-slate-400">Signed catalog snapshot · local command authority</p>
            </div>
          </div>
          <div className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${cloudState === 'CONNECTED' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'}`}>
            {cloudIcon}
            <span><strong className="block">Cloud {cloudState.toLowerCase()}</strong><small className="block">{health?.outboxDepth || 0} locally committed event(s) awaiting acknowledgement</small><small className="block">{peerTransportActive ? 'Paired LAN transport active' : 'Paired LAN transport unavailable; this Hub remains local authority'}</small></span>
          </div>
        </header>

        {message && <p className="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-sm leading-relaxed text-slate-300" role="status">{message}</p>}

        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-100">
          <strong>Local reservation, not settlement:</strong> this slice records a tender intent and reserves signed Hub stock in the same local transaction. It does not capture cash, card, or QR payment, post a financial settlement, or claim a completed sale.
        </section>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="rounded-3xl border border-slate-800 bg-slate-900 p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">Signed menu</h2>
                <p className="text-xs text-slate-400">The Hub recalculates each price and VAT amount before committing.</p>
              </div>
              <input value={search} onChange={(event) => setSearch(event.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 sm:w-64" placeholder="Find menu item" aria-label="Find signed menu item" />
            </div>
            {products.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {products.map((product) => (
                  <button key={product.id} type="button" disabled={submitting || product.stockQuantity < 1} onClick={() => addProduct(product)} className="rounded-2xl border border-slate-800 bg-slate-950 p-4 text-left transition hover:border-emerald-500/50 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60">
                    <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{product.category}</span>
                    <strong className="mt-1 block text-sm text-slate-100">{product.name}</strong>
                    <span className="mt-3 block text-base font-bold text-emerald-300">{money.format(product.price)}</span>
                    <small className="mt-1 block text-xs text-slate-500">{product.stockQuantity} {product.unit} available in the signed Hub snapshot</small>
                  </button>
                ))}
              </div>
            ) : <p className="rounded-2xl border border-slate-800 bg-slate-950 p-5 text-sm text-slate-400">No active signed catalog products match this search.</p>}
          </section>

          <aside className="h-fit rounded-3xl border border-slate-800 bg-slate-900 p-5 lg:sticky lg:top-5">
            <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2"><ShoppingBasket className="h-5 w-5 text-emerald-300" aria-hidden="true" /><h2 className="text-lg font-bold">Order draft</h2></div>
              <span className="text-xs text-slate-500">{basket.reduce((count, line) => count + line.quantity, 0)} item(s)</span>
            </div>
            <div className="max-h-72 space-y-3 overflow-auto py-4">
              {basket.length ? basket.map((line) => (
                <div key={line.productId} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                  <div className="flex justify-between gap-3"><strong className="text-sm">{line.name}</strong><span className="text-sm font-semibold text-emerald-300">{money.format(line.price * line.quantity)}</span></div>
                  <div className="mt-3 flex items-center justify-between"><span className="text-xs text-slate-500">{money.format(line.price)} each</span><span className="inline-flex items-center gap-2"><button type="button" disabled={submitting} onClick={() => changeQuantity(line.productId, -1)} className="rounded-lg border border-slate-700 p-1 text-slate-200 hover:bg-slate-900 disabled:opacity-50" aria-label={`Remove one ${line.name}`}><Minus className="h-3.5 w-3.5" /></button><strong className="w-5 text-center text-sm">{line.quantity}</strong><button type="button" disabled={submitting} onClick={() => changeQuantity(line.productId, 1)} className="rounded-lg border border-slate-700 p-1 text-slate-200 hover:bg-slate-900 disabled:opacity-50" aria-label={`Add one ${line.name}`}><Plus className="h-3.5 w-3.5" /></button></span></div>
                </div>
              )) : <p className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-sm text-slate-500">Choose signed menu items to begin.</p>}
            </div>
            <label className="block border-t border-slate-800 pt-4 text-xs font-semibold text-slate-300">Tender intent
              <select value={paymentMethod} disabled={submitting} onChange={(event) => { setPendingRequest(null); setPaymentMethod(event.target.value as typeof paymentMethod); }} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 disabled:opacity-50">
                <option value="CASH">Cash — settlement pending</option>
                <option value="CARD">Card — settlement pending</option>
                <option value="SPAZAPAY_QR">SpazaPay QR — settlement pending</option>
              </select>
            </label>
            <dl className="mt-4 space-y-2 border-t border-slate-800 pt-4 text-sm"><div className="flex justify-between text-slate-400"><dt>Subtotal</dt><dd>{money.format(subtotal)}</dd></div><div className="flex justify-between text-slate-400"><dt>VAT {context.vat.enabled ? `(${context.vat.rate}%)` : '(not enabled)'}</dt><dd>{money.format(tax)}</dd></div><div className="flex justify-between text-base font-black text-slate-100"><dt>Order total</dt><dd>{money.format(total)}</dd></div></dl>
            <button type="button" disabled={!basket.length || submitting} onClick={() => void submitCurrentOrder()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-4 py-3 text-sm font-black text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"><ReceiptText className="h-4 w-4" aria-hidden="true" />{submitting ? 'Committing locally…' : pendingRequest ? 'Retry the same native request' : 'Commit order locally'}</button>
            {pendingRequest && <button type="button" disabled={submitting} onClick={() => { setPendingRequest(null); setMessage('The pending request was discarded. The draft remains so you can refresh the signed Hub state before creating a new request.'); }} className="mt-3 w-full rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs font-bold text-amber-100 hover:bg-amber-500/20 disabled:opacity-50">Discard pending request after review</button>}
            <button type="button" onClick={() => void refreshNativeState().catch((error) => setMessage(error instanceof Error ? error.message : 'Native state could not be refreshed.'))} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-slate-800"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh measured Hub state</button>
            <button type="button" onClick={onSignOut} className="mt-3 flex w-full items-center justify-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-300"><WifiOff className="h-3.5 w-3.5" aria-hidden="true" />Return to owner browser shell</button>
          </aside>
        </div>
      </div>
    </main>
  );
};

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
