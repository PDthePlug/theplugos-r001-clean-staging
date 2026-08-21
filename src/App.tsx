import React, { lazy, Suspense, useEffect, useState } from 'react';
import { PlugOSProvider } from '@plugos/react';
import { sdk } from '@plugos/sdk';
import { IndexedDBStorageAdapter, InMemoryStorageAdapter } from '@plugos/core';
import { UserSession, UserRole, OrderRecord, ProductItem, StaffMember, SupplierRecord, CustomerRecord, RestockRequest, Branch } from './types';

// Role Workspaces
import { WelcomeScreen, BusinessAuthSession } from './screens/WelcomeScreen';
import { supabase } from './lib/supabase';
import { verifyDeviceStatus, getDeviceBootstrap } from './lib/security';
import { mapStaffRowToStaffMember, mapCatalogProductRowToProductItem, mapBranchRowToBranch } from './lib/mappers';
import { RoleHeader } from './components/RoleHeader';
import { syncService } from './services/SyncService';
import { validateOrderTransition } from './services/OrderStateMachine';

// FastFood & StoreItems Reducers
import { reducers as fastfoodReducers } from '../fastfood-domain/src/index';

const FirstTimeSetupWizard = lazy(() =>
  import('./screens/FirstTimeSetupWizard').then((module) => ({ default: module.FirstTimeSetupWizard }))
);
const RoleLoginModal = lazy(() =>
  import('./components/RoleLoginModal').then((module) => ({ default: module.RoleLoginModal }))
);
const OfflineHubInspector = lazy(() =>
  import('./components/OfflineHubInspector').then((module) => ({ default: module.OfflineHubInspector }))
);
const DevicePairingWizard = lazy(() =>
  import('./components/DevicePairingWizard').then((module) => ({ default: module.DevicePairingWizard }))
);
const SyncDiagnosticsModal = lazy(() =>
  import('./components/SyncDiagnosticsModal').then((module) => ({ default: module.SyncDiagnosticsModal }))
);
const CashierWorkspace = lazy(() =>
  import('./workspaces/CashierWorkspace').then((module) => ({ default: module.CashierWorkspace }))
);
const KitchenWorkspace = lazy(() =>
  import('./workspaces/KitchenWorkspace').then((module) => ({ default: module.KitchenWorkspace }))
);
const ManagerWorkspace = lazy(() =>
  import('./workspaces/ManagerWorkspace').then((module) => ({ default: module.ManagerWorkspace }))
);
const OwnerWorkspace = lazy(() =>
  import('./workspaces/OwnerWorkspace').then((module) => ({ default: module.OwnerWorkspace }))
);
const AdminWorkspace = lazy(() =>
  import('./workspaces/AdminWorkspace').then((module) => ({ default: module.AdminWorkspace }))
);

const OperatingSurfaceLoading = () => (
  <div className="plug-surface-loading" role="status" aria-live="polite">
    <span aria-hidden="true" />
    <div>
      <strong>Preparing your workspace</strong>
      <small>Restoring the local operating context…</small>
    </div>
  </div>
);

// Helper function for local Web Audio API notification chimes
function playNotificationChime(type: 'NEW_ORDER' | 'ORDER_READY' | 'SUCCESS') {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    
    if (type === 'ORDER_READY') {
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(880, ctx.currentTime); // A5
      osc1.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.15); // D6
      gain1.gain.setValueAtTime(0.3, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.45);
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    }
  } catch (e) {
    console.log('Audio chime unavailable', e);
  }
}

function MainOSApp() {
  // Session State - starts on null to prompt role login
  const [businessAuth, setBusinessAuth] = useState<BusinessAuthSession | null>(null);
  const [session, setSession] = useState<UserSession | null>(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);

  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [restockRequests, setRestockRequests] = useState<RestockRequest[]>([]);
  const [kernelEvents, setKernelEvents] = useState<any[]>([]);
  const [outboxCount, setOutboxCount] = useState<number>(0);
  const [showHubInspector, setShowHubInspector] = useState<boolean>(false);
  const [showPairingWizard, setShowPairingWizard] = useState<boolean>(false);
  const [showSyncDiagnostics, setShowSyncDiagnostics] = useState<boolean>(false);

  // Subscribe to live multi-device sync bus & initial fetch
  useEffect(() => {
    const unsubscribe = syncService.subscribe({
      onOrdersUpdated: (newOrders) => {
        setOrders(newOrders);
      },
      onProductsUpdated: (newProducts) => {
        setProducts(newProducts);
      },
      onStaffUpdated: (newStaff) => {
        setStaffList(newStaff);
      }
    });

    syncService.fetchAndSyncOrders().then(o => { if (o && o.length > 0) setOrders(o); });
    syncService.fetchAndSyncProducts().then(p => { if (p && p.length > 0) setProducts(p); });
    syncService.fetchAndSyncStaff().then(s => { if (s && s.length > 0) setStaffList(s); });

    return () => unsubscribe();
  }, []);
  
  // Business VAT Configuration (Disabled by default per Directive 017)
  const [vatConfig, setVatConfig] = useState<{ enabled: boolean; rate: number }>({ enabled: false, rate: 15 });

  // Load Business Auth & Restore Terminal Context
  useEffect(() => {
    async function restoreIdentity() {
      console.log('[SESSION_RESTORE] Initiating application boot identity restoration...');
      const storedBiz = localStorage.getItem('plugos_business_auth');
      const storedDeviceId = localStorage.getItem('plugos_device_id');

      let currentBizAuth: BusinessAuthSession | null = storedBiz ? JSON.parse(storedBiz) : null;

      // Check current Supabase Auth session first
      const { data: { session: currentSession } } = await supabase.auth.getSession();

      if (currentSession?.user) {
        console.log('[SESSION_RESTORE] Supabase Auth session detected for user_id:', currentSession.user.id);
        
        try {
          const { data: memberData } = await supabase
            .from('business_memberships')
            .select('business_id, role, businesses(id, name, onboarding_status, owner_id)')
            .eq('user_id', currentSession.user.id)
            .maybeSingle();

          let bizId = memberData?.business_id;
          let bizName = (memberData?.businesses as any)?.name;

          if (!bizId) {
            const { data: bData } = await supabase
              .from('businesses')
              .select('id, name, onboarding_status, owner_id')
              .eq('owner_id', currentSession.user.id)
              .maybeSingle();

            if (bData) {
              bizId = bData.id;
              bizName = bData.name;
            }
          }

          if (bizId) {
            const { data: branchData } = await supabase
              .from('branches')
              .select('id, name')
              .eq('business_id', bizId)
              .order('created_at', { ascending: true })
              .limit(1)
              .maybeSingle();

            if (branchData) {
              currentBizAuth = {
                businessId: bizId,
                businessName: bizName || 'My Business',
                branchId: branchData.id,
                branchName: branchData.name,
                ownerId: currentSession.user.id,
                isOwner: true,
                deviceId: storedDeviceId || undefined
              };
              console.log('[SESSION_RESTORE] Successfully restored owner business auth from cloud state:', {
                businessId: bizId,
                branchId: branchData.id,
                ownerId: currentSession.user.id
              });
            }
          }
        } catch (e) {
          console.warn('[SESSION_RESTORE] Could not restore business auth from cloud:', e);
        }

        const storedProfile = localStorage.getItem('plugos_profile');
        if (storedProfile) {
          try {
            setSession(JSON.parse(storedProfile));
          } catch(e) {}
        }
      } else if (storedDeviceId) {
        try {
          // Verify cloud device authorization status via R002 RPC
          const devStatus = await verifyDeviceStatus(storedDeviceId);
          if (devStatus.active) {
            const bootstrap = await getDeviceBootstrap(storedDeviceId);
            if (bootstrap.success && bootstrap.business && bootstrap.branch) {
              currentBizAuth = {
                businessId: bootstrap.business.id,
                businessName: bootstrap.business.name || 'Paired Business',
                branchId: bootstrap.branch.id,
                branchName: bootstrap.branch.name || 'Branch',
                ownerId: bootstrap.business.owner_id || '',
                isOwner: false,
                deviceId: storedDeviceId
              };
            }
          } else {
            console.warn('[SECURITY_DEVICE_REJECTED] Device is not active or revoked:', devStatus.status);
            localStorage.removeItem('plugos_enrollment');
            localStorage.removeItem('plugos_business_auth');
            currentBizAuth = null;
          }
        } catch (e) {
          console.error('[SECURITY_RESTORE_EXCEPTION]', e);
        }
      }

      if (currentBizAuth) {
        await handleBusinessAuthSuccess(currentBizAuth);
      }
    }

    restoreIdentity();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      console.log('[SESSION_RESTORE] Auth state change event:', _event);
      if (!currentSession) {
        setSession(null);
        setBusinessAuth(null);
        setShowSetupWizard(false);
        localStorage.removeItem('plugos_profile');
        localStorage.removeItem('plugos_business_auth');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleBusinessAuthSuccess = async (newBizAuth: BusinessAuthSession) => {
    console.log('[BUSINESS_RESTORE] Setting active business auth session:', newBizAuth.businessId);
    setBusinessAuth(newBizAuth);
    localStorage.setItem('plugos_business_auth', JSON.stringify(newBizAuth));
    syncService.setBusinessContext(newBizAuth.businessId, newBizAuth.branchId || '');
    
    try {
      // Query Supabase for authoritative cloud state
      let supabaseStaff: any[] = [];
      let supabaseBranches: any[] = [];
      let supabaseProducts: ProductItem[] = [];
      let cloudOnboardingStatus = 'NOT_STARTED';

      if (supabase) {
        try {
          const { data: bData } = await supabase.from('businesses').select('id, name, onboarding_status').eq('id', newBizAuth.businessId).maybeSingle();
          if (bData && bData.onboarding_status) {
            cloudOnboardingStatus = bData.onboarding_status;
            console.log('[ONBOARDING_STATUS] Authoritative cloud onboarding_status for business', newBizAuth.businessId, 'is:', cloudOnboardingStatus);
          }

          const { data: stData } = await supabase.from('staff_members').select('*').eq('business_id', newBizAuth.businessId);
          if (stData && stData.length > 0) supabaseStaff = stData.map(mapStaffRowToStaffMember);

          const { data: brData } = await supabase.from('branches').select('*').eq('business_id', newBizAuth.businessId);
          if (brData && brData.length > 0) supabaseBranches = brData.map(mapBranchRowToBranch);

          const { data: prData } = await supabase.from('catalog_products').select('*').eq('business_id', newBizAuth.businessId);
          if (prData) {
            supabaseProducts = prData.map(mapCatalogProductRowToProductItem);
            console.log('[CATALOG_RESTORE] Authoritative cloud catalog_products restored:', supabaseProducts.length);
          }
        } catch (e) {
          console.warn('[BUSINESS_RESTORE] Cloud query warning:', e);
        }
      }

      // Check local storage for fallback cache
      const localBiz = await sdk.storage.get('businesses', newBizAuth.businessId) || await sdk.storage.get('businesses', 'current');
      if (localBiz && localBiz.onboarding_status === 'COMPLETED') {
        if (cloudOnboardingStatus !== 'COMPLETED') {
          console.log('[ONBOARDING_STATUS] Local cache reports COMPLETED, but cloud status is:', cloudOnboardingStatus);
        }
      }

      // Resolve final staff and branch directories
      const resolvedStaff = (supabaseStaff.length > 0) ? supabaseStaff :
                            (await sdk.storage.get('staff', 'directory')) || [];

      const resolvedBranches = (supabaseBranches.length > 0) ? supabaseBranches :
                               (await sdk.storage.get('branches', 'directory')) || [];

      if (resolvedStaff.length > 0) {
        setStaffList(resolvedStaff);
        await sdk.storage.set('staff', 'directory', resolvedStaff);
      }
      if (resolvedBranches.length > 0) {
        setBranches(resolvedBranches);
        await sdk.storage.set('branches', 'directory', resolvedBranches);
      }

      if (newBizAuth.isOwner) {
        // Authoritative cloud catalog restoration for authenticated owner
        setProducts(supabaseProducts);
        await sdk.storage.set('catalog', 'products', supabaseProducts);
      } else {
        const resolvedProducts = (supabaseProducts.length > 0) ? supabaseProducts :
                                 (await sdk.storage.get('catalog', 'products')) || [];
        setProducts(resolvedProducts);
        await sdk.storage.set('catalog', 'products', resolvedProducts);
      }

      // Authoritative onboarding decision logic
      if (newBizAuth.isOwner) {
        if (cloudOnboardingStatus === 'COMPLETED') {
          console.log('[ONBOARDING_STATUS] Onboarding is COMPLETED in cloud database. Skipping wizard.');
          setShowSetupWizard(false);
        } else {
          console.log('[ONBOARDING_STATUS] Onboarding status is', cloudOnboardingStatus, '. Launching setup wizard.');
          setShowSetupWizard(true);
        }
      } else {
        setShowSetupWizard(false);
      }
    } catch (e) {
      console.warn('Error configuring business auth context:', e);
      if (!newBizAuth.isOwner) {
        setShowSetupWizard(false);
      }
    }
  };

  const handleTerminalLoginSuccess = (newSession: UserSession) => {
    setSession(newSession);
    localStorage.setItem('plugos_profile', JSON.stringify(newSession));
  };

  // Kernel Boot Sequence
  useEffect(() => {
    let isMounted = true;

    async function bootKernel() {
      try {
        await sdk.boot({
          storageAdapter: new IndexedDBStorageAdapter(),
        });

        // Load or initialize persisted state from repository
        try {
          const savedProducts = await sdk.storage.get('catalog', 'products');
          if (Array.isArray(savedProducts) && savedProducts.length > 0) {
            console.log('[PERSISTENCE DIAGNOSTIC] Loaded catalog products:', savedProducts.length, 'items');
            setProducts(savedProducts);
          } else {
            console.log('[PERSISTENCE DIAGNOSTIC] Catalog products repository empty. Initialized with empty array.');
            setProducts([]);
          }

          const savedStaff = await sdk.storage.get('staff', 'directory');
          if (Array.isArray(savedStaff) && savedStaff.length > 0) {
            console.log('[PERSISTENCE DIAGNOSTIC] Loaded staff directory:', savedStaff.length, 'members');
            setStaffList(savedStaff);
          } else {
            console.log('[PERSISTENCE DIAGNOSTIC] Staff directory repository empty. Initialized with empty array.');
            setStaffList([]);
          }

          const savedBranches = await sdk.storage.get('branches', 'directory');
          if (Array.isArray(savedBranches) && savedBranches.length > 0) {
            console.log('[PERSISTENCE DIAGNOSTIC] Loaded branches directory:', savedBranches.length, 'branches');
            setBranches(savedBranches);
          } else {
            console.log('[PERSISTENCE DIAGNOSTIC] Branches directory repository empty. Initialized with empty array.');
            setBranches([]);
          }

          const savedSuppliers = await sdk.storage.get('suppliers', 'directory');
          if (Array.isArray(savedSuppliers) && savedSuppliers.length > 0) {
            console.log('[PERSISTENCE DIAGNOSTIC] Loaded suppliers directory:', savedSuppliers.length, 'suppliers');
            setSuppliers(savedSuppliers);
          } else {
            console.log('[PERSISTENCE DIAGNOSTIC] Suppliers directory repository empty. Initialized with empty array.');
            setSuppliers([]);
          }

          const savedCustomers = await sdk.storage.get('customers', 'database');
          if (Array.isArray(savedCustomers) && savedCustomers.length > 0) {
            console.log('[PERSISTENCE DIAGNOSTIC] Loaded customers database:', savedCustomers.length, 'customers');
            setCustomers(savedCustomers);
          } else {
            console.log('[PERSISTENCE DIAGNOSTIC] Customers database repository empty. Initialized with empty array.');
            setCustomers([]);
          }

          const savedRestock = await sdk.storage.get('restock', 'requests');
          if (Array.isArray(savedRestock) && savedRestock.length > 0) {
            console.log('[PERSISTENCE DIAGNOSTIC] Loaded restock requests:', savedRestock.length, 'requests');
            setRestockRequests(savedRestock);
          } else {
            console.log('[PERSISTENCE DIAGNOSTIC] Restock requests repository empty. Initialized with empty array.');
            setRestockRequests([]);
          }

          const savedOrders = await sdk.storage.get('orders', 'history');
          if (Array.isArray(savedOrders) && savedOrders.length > 0) {
            console.log('[PERSISTENCE DIAGNOSTIC] Loaded order history:', savedOrders.length, 'orders');
            setOrders(savedOrders);
          } else {
            console.log('[PERSISTENCE DIAGNOSTIC] Order history repository empty. Initialized with empty array.');
            setOrders([]);
          }

          const savedVat = await sdk.storage.get('config', 'vat');
          if (savedVat && typeof savedVat.enabled === 'boolean') {
            console.log('[PERSISTENCE DIAGNOSTIC] Loaded VAT config:', savedVat);
            setVatConfig(savedVat);
          }
        } catch (e) {
          console.warn('[PERSISTENCE DIAGNOSTIC] Storage initialization fallback', e);
        }

        // Register domain state reducers
        sdk.state.registerReducer('order', fastfoodReducers.order);
        sdk.state.registerReducer('inventory', fastfoodReducers.inventory);

        // Register operational business rules
        sdk.rules.register('fastfood-domain', [
          {
            id: 'low_inventory_alert',
            condition: 'event.payload.quantity < 10',
            action: 'DISPATCH_MANAGER_ALERT'
          }
        ]);

        // Subscribe to global event bus stream
        sdk.events.subscribe('*', async (event: any) => {
          if (!isMounted) return;
          setKernelEvents(prev => [event, ...prev]);
        });

      } catch (err) {
        console.error('ThePlugOS Kernel boot exception:', err);
      }
    }

    bootKernel();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleUpdateProducts = async (updated: ProductItem[]) => {
    setProducts(updated);
    try {
      await sdk.storage.set('catalog', 'products', updated);
      await syncService.syncProducts(updated);
    } catch (e) {
      console.error('Failed saving products', e);
    }
  };

  const handleUpdateStaff = async (updated: StaffMember[]) => {
    setStaffList(updated);
    try {
      await sdk.storage.set('staff', 'directory', updated);
      await syncService.syncStaff(updated);
    } catch (e) {
      console.error('Failed saving staff', e);
    }
  };

  const handleUpdateSuppliers = async (updated: SupplierRecord[]) => {
    setSuppliers(updated);
    try {
      await sdk.storage.set('suppliers', 'directory', updated);
    } catch (e) {
      console.error('Failed saving suppliers', e);
    }
  };

  const handleUpdateCustomers = async (updated: CustomerRecord[]) => {
    setCustomers(updated);
    try {
      await sdk.storage.set('customers', 'database', updated);
    } catch (e) {
      console.error('Failed saving customers', e);
    }
  };

  const handleUpdateRestockRequests = async (updated: RestockRequest[]) => {
    setRestockRequests(updated);
    try {
      await sdk.storage.set('restock', 'requests', updated);
    } catch (e) {
      console.error('Failed saving restock requests', e);
    }
  };

  const handleAddRestockRequest = async (request: RestockRequest) => {
    const updated = [request, ...restockRequests];
    setRestockRequests(updated);
    try {
      await sdk.storage.set('restock', 'requests', updated);
    } catch (e) {
      console.error('Failed adding restock request', e);
    }
  };

  const handleUpdateVatConfig = async (newConfig: { enabled: boolean; rate: number }) => {
    setVatConfig(newConfig);
    try {
      await sdk.storage.set('config', 'vat', newConfig);
    } catch (e) {
      console.error('Failed saving VAT config', e);
    }
  };

  // Handle placing a new order from Cashier terminal
  const handlePlaceOrder = async (newOrder: OrderRecord) => {
    const updatedOrders = [newOrder, ...orders];
    setOrders(updatedOrders);
    try {
      await sdk.storage.set('orders', 'history', updatedOrders);
      await syncService.syncOrder(newOrder, 'UPSERT');
    } catch (e) {
      console.error('Failed saving orders', e);
    }

    // Directive 012 Audit Trail Logging
    await syncService.logAuditEvent({
      eventType: 'ORDER_CREATED',
      entityId: newOrder.id,
      actorId: newOrder.cashierId,
      details: { totalAmount: newOrder.totalAmount, itemsCount: newOrder.items.length }
    });
    await syncService.logAuditEvent({
      eventType: 'ORDER_SUBMITTED',
      entityId: newOrder.id,
      actorId: newOrder.cashierId
    });
    await syncService.logAuditEvent({
      eventType: 'PAYMENT_RECORDED',
      entityId: newOrder.id,
      actorId: newOrder.cashierId,
      details: { paymentType: newOrder.paymentType, paymentMethod: newOrder.paymentMethod, amount: newOrder.totalAmount }
    });

    // Phase 1, 2 & 3: Single Source of Truth Inventory & Recipe Engine
    // Map existing products array to mutate stock for recipes and direct items
    let updatedProducts = [...products];

    newOrder.items.forEach(orderItem => {
      const prod = updatedProducts.find(p => p.id === orderItem.productId || p.name === orderItem.name);
      if (prod) {
        // Deduct direct product stock
        prod.stock = Math.max(0, prod.stock - orderItem.quantity);

        // If product has recipe ingredients (BOM), deduct raw ingredients from inventory
        if (prod.recipe && prod.recipe.length > 0) {
          prod.recipe.forEach(ingredient => {
            const rawItem = updatedProducts.find(
              p => p.id === ingredient.rawItemId || p.name === ingredient.rawItemName
            );
            if (rawItem) {
              const qtyToDeduct = (ingredient.quantity || 0) * orderItem.quantity;
              rawItem.stock = Math.max(0, Number((rawItem.stock - qtyToDeduct).toFixed(2)));
            }
          });
        }
      }
    });

    setProducts(updatedProducts);
    try {
      await sdk.storage.set('catalog', 'products', updatedProducts);
      await syncService.logAuditEvent({
        eventType: 'INVENTORY_DEDUCTED',
        entityId: newOrder.id,
        actorId: newOrder.cashierId
      });
    } catch (e) {
      console.error('Failed updating product stock', e);
    }

    // Phase 6: Customer Database Auto-Update
    if (newOrder.customerPhone && newOrder.customerPhone.trim().length > 0) {
      const cleanPhone = newOrder.customerPhone.trim();
      const existingCust = customers.find(c => c.phone === cleanPhone);
      const itemNames = newOrder.items.map(i => i.name);

      let updatedCustList: CustomerRecord[];
      if (existingCust) {
        const newVisits = existingCust.visits + 1;
        const newLifetime = existingCust.lifetimeSpend + newOrder.totalAmount;
        const newAvg = Number((newLifetime / newVisits).toFixed(2));
        const combinedFavs = Array.from(new Set([...existingCust.favouriteProducts, ...itemNames]));

        updatedCustList = customers.map(c => 
          c.id === existingCust.id 
            ? {
                ...c,
                visits: newVisits,
                lifetimeSpend: newLifetime,
                avgBasket: newAvg,
                lastVisit: newOrder.createdAt,
                favouriteProducts: combinedFavs,
                name: newOrder.customerName || c.name
              }
            : c
        );
      } else {
        const newCust: CustomerRecord = {
          id: `cust-${Date.now().toString().slice(-4)}`,
          phone: cleanPhone,
          name: newOrder.customerName || 'Walk-in Customer',
          visits: 1,
          lifetimeSpend: newOrder.totalAmount,
          avgBasket: newOrder.totalAmount,
          lastVisit: newOrder.createdAt,
          favouriteProducts: itemNames,
          createdAt: newOrder.createdAt
        };
        updatedCustList = [newCust, ...customers];
      }

      setCustomers(updatedCustList);
      try {
        await sdk.storage.set('customers', 'database', updatedCustList);
      } catch (e) {
        console.error('Failed saving updated customer profile', e);
      }
    }

    if (!isOnline) {
      setOutboxCount(prev => prev + 1);
    }

    playNotificationChime('NEW_ORDER');

    // Dispatch event into Kernel Engine
    await sdk.events.publish(
      newOrder.id,
      'order',
      'ORDER_PLACED',
      {
        orderId: newOrder.id,
        branchId: newOrder.branchId,
        cashierId: newOrder.cashierId,
        items: newOrder.items,
        totalAmount: newOrder.totalAmount,
        paymentType: newOrder.paymentType,
        timestamp: newOrder.createdAt
      }
    );

    // Trigger low inventory event if items drop to 10 or lower
    updatedProducts.forEach(async (p) => {
      const isOrdered = newOrder.items.some(i => i.productId === p.id || i.name === p.name);
      if (isOrdered && p.stock <= 10) {
        await sdk.events.publish(
          p.id,
          'inventory',
          p.stock === 0 ? 'OUT_OF_STOCK_ALERT' : 'LOW_INVENTORY_ALERT',
          { productId: p.id, productName: p.name, currentStock: p.stock, timestamp: new Date().toISOString() }
        );
      }
    });
  };

  // Phase 7: Handle Void / Refund Order and restore Inventory
  const handleVoidOrder = async (orderId: string, refundedBy: string) => {
    const targetOrder = orders.find(o => o.id === orderId);
    if (!targetOrder || targetOrder.status === 'CANCELLED') return;

    // 1. Mark order as CANCELLED
    const updatedOrders = orders.map(o => 
      o.id === orderId 
        ? { 
            ...o, 
            status: 'CANCELLED' as const, 
            voidedAt: new Date().toISOString(),
            refundedBy 
          } 
        : o
    );

    setOrders(updatedOrders);
    try {
      await sdk.storage.set('orders', 'history', updatedOrders);
    } catch (e) {
      console.error('Failed saving voided order', e);
    }

    // 2. Revert Stock Deductions (Products & Recipes)
    let restoredProducts = [...products];
    targetOrder.items.forEach(orderItem => {
      const prod = restoredProducts.find(p => p.id === orderItem.productId || p.name === orderItem.name);
      if (prod) {
        prod.stock += orderItem.quantity;
        if (prod.recipe && prod.recipe.length > 0) {
          prod.recipe.forEach(ingredient => {
            const rawItem = restoredProducts.find(
              p => p.id === ingredient.rawItemId || p.name === ingredient.rawItemName
            );
            if (rawItem) {
              const qtyToRestore = (ingredient.quantity || 0) * orderItem.quantity;
              rawItem.stock = Number((rawItem.stock + qtyToRestore).toFixed(2));
            }
          });
        }
      }
    });

    setProducts(restoredProducts);
    try {
      await sdk.storage.set('catalog', 'products', restoredProducts);
    } catch (e) {
      console.error('Failed saving restored stock', e);
    }

    // 3. Publish Event & Audit Trail
    await syncService.logAuditEvent({
      eventType: 'ORDER_VOIDED',
      entityId: orderId,
      actorId: refundedBy
    });

    await sdk.events.publish(
      orderId,
      'order',
      'ORDER_VOIDED',
      {
        orderId,
        refundedBy,
        voidedAt: new Date().toISOString()
      }
    );
  };

  // Handle kitchen order status updates with State Machine enforcement
  const handleUpdateOrderStatus = async (orderId: string, status: OrderRecord['status']) => {
    const existingOrder = orders.find(o => o.id === orderId);
    if (existingOrder) {
      try {
        validateOrderTransition(orderId, existingOrder.status, status);
      } catch (err: any) {
        console.error('[ORDER STATE MACHINE TRANSITION REJECTED]', err.message);
        alert(`Order State Machine Error: ${err.message}`);
        return;
      }
    }

    const updatedOrders = orders.map(o => o.id === orderId ? { ...o, status, updatedAt: new Date().toISOString() } : o);
    setOrders(updatedOrders);
    try {
      await sdk.storage.set('orders', 'history', updatedOrders);
      const updatedOrder = updatedOrders.find(o => o.id === orderId);
      if (updatedOrder) {
        await syncService.syncOrder(updatedOrder, 'STATUS_CHANGE', existingOrder?.status);
      }
    } catch (e) {
      console.error('Failed saving orders status', e);
    }

    if (status === 'READY') {
      playNotificationChime('ORDER_READY');
    } else {
      playNotificationChime('SUCCESS');
    }

    let actionName = 'ORDER_STATUS_UPDATED';
    let auditEventType = 'ORDER_STATUS_CHANGED';
    if (status === 'PREP' || status === 'IN_PREP') {
      actionName = 'KITCHEN_PREP_STARTED';
      auditEventType = 'ORDER_STARTED';
    }
    if (status === 'READY') {
      actionName = 'ORDER_READY_FOR_COLLECTION';
      auditEventType = 'ORDER_READY';
    }
    if (status === 'COMPLETED' || status === 'FULFILLED') {
      actionName = 'ORDER_HANDOVER_COMPLETED';
      auditEventType = 'ORDER_FULFILLED';
    }

    await syncService.logAuditEvent({
      eventType: auditEventType,
      entityId: orderId,
      actorId: session?.userId || 'system',
      details: { newStatus: status }
    });

    await sdk.events.publish(
      orderId,
      'order',
      actionName,
      { orderId, status, timestamp: new Date().toISOString() }
    );
  };

  const handleToggleOnline = () => {
    const nextState = !isOnline;
    setIsOnline(nextState);
    sdk.network.setOnlineStatus(nextState);
    if (nextState) {
      setOutboxCount(0); // Flush outbox on reconnect
    }
  };

  const handleLogout = async () => {
    console.log('[OWNER_LOGOUT] Initiating owner logout for business_id:', businessAuth?.businessId);
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('[OWNER_LOGOUT] Supabase sign out warning:', e);
    }
    setSession(null);
    setBusinessAuth(null);
    setShowSetupWizard(false);
    localStorage.removeItem('plugos_profile');
    localStorage.removeItem('plugos_business_auth');
    console.log('[OWNER_LOGOUT] Owner session successfully terminated. Returning to entry surface.');
  };

  const handleUnpairDevice = async () => {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('Supabase sign out error:', e);
    }
    setSession(null);
    setBusinessAuth(null);
    setShowSetupWizard(false);
    localStorage.removeItem('plugos_profile');
    localStorage.removeItem('plugos_business_auth');
    localStorage.removeItem('plugos_enrollment');
  };

  return (
    <div className="plug-os-root min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-amber-500 selection:text-slate-950">
      
      {/* 1. If not authenticated with business, show WelcomeScreen (Cloud/Pair Auth) */}
      {!businessAuth && (
        <WelcomeScreen onLoginSuccess={handleBusinessAuthSuccess} />
      )}
      
      {/* 2. If business authenticated but setup needed */}
      {businessAuth && showSetupWizard && (
        <Suspense fallback={<OperatingSurfaceLoading />}>
        <FirstTimeSetupWizard 
          businessAuth={{ 
            businessId: businessAuth.businessId, 
            businessName: businessAuth.businessName,
            branchId: businessAuth.branchId!, 
            branchName: businessAuth.branchName!,
            isOwner: businessAuth.isOwner,
            ownerId: businessAuth.ownerId
          }}
          onComplete={async () => {
            try {
              const { data: stData } = await supabase.from('staff_members').select('*').eq('business_id', businessAuth.businessId);
              if (stData && stData.length > 0) {
                const mappedStaff = stData.map(mapStaffRowToStaffMember);
                setStaffList(mappedStaff);
                await sdk.storage.set('staff', 'directory', mappedStaff);
              }
            } catch(e) {}
            setShowSetupWizard(false);
          }}
        />
        </Suspense>
      )}

      {/* 3. If business authenticated, setup complete, but no terminal session */}
      {businessAuth && !showSetupWizard && !session && (
        <Suspense fallback={<OperatingSurfaceLoading />}>
        <RoleLoginModal
          businessId={businessAuth.businessId}
          onLoginSuccess={handleTerminalLoginSuccess}
          currentSession={null}
          staffList={staffList}
          branches={branches}
        />
        </Suspense>
      )}

      {/* 4. OS Workspace */}
      {businessAuth && !showSetupWizard && session && (
        <>
          {/* OS Shell Header */}
          <RoleHeader
            session={session}
            isOnline={isOnline}
            onToggleOnline={handleToggleOnline}
            outboxCount={outboxCount}
            onLockSession={() => setSession(null)}
            onLogout={handleLogout}
            onOpenHubInspector={() => setShowHubInspector(true)}
            onOpenPairingWizard={() => setShowPairingWizard(true)}
            onOpenSyncDiagnostics={() => setShowSyncDiagnostics(true)}
          />

          {/* Sync Diagnostics Modal */}
          {showSyncDiagnostics && (
            <Suspense fallback={null}>
            <SyncDiagnosticsModal onClose={() => setShowSyncDiagnostics(false)} />
            </Suspense>
          )}

          {/* Local Hub Infrastructure & Offline Mesh Inspector Modal */}
          {showHubInspector && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 p-4 overflow-y-auto flex items-center justify-center">
              <Suspense fallback={<OperatingSurfaceLoading />}>
              <OfflineHubInspector
                kernel={sdk}
                onClose={() => setShowHubInspector(false)}
              />
              </Suspense>
            </div>
          )}

          {/* Device Pairing Wizard Modal */}
          {showPairingWizard && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 p-4 overflow-y-auto flex items-center justify-center">
              <Suspense fallback={<OperatingSurfaceLoading />}>
              <DevicePairingWizard
                kernel={sdk}
                branchName={session.branchName}
                branchId={session.branchId}
                businessId={session.businessId}
                sessionToken={session.sessionToken}
                onClose={() => setShowPairingWizard(false)}
              />
              </Suspense>
            </div>
          )}

          {/* Strict Role-Based Workspace Routing */}
          <main className="plug-workspace-host flex-1">
            <Suspense fallback={<OperatingSurfaceLoading />}>
            {session.role === 'CASHIER' && (
              <CashierWorkspace
                session={session}
                kernel={sdk}
                orders={orders}
                products={products}
                onPlaceOrder={handlePlaceOrder}
                onUpdateOrderStatus={handleUpdateOrderStatus}
                onVoidOrder={handleVoidOrder}
                vatConfig={vatConfig}
                customers={customers}
                onUpdateCustomers={handleUpdateCustomers}
              />
            )}

            {session.role === 'KITCHEN_STAFF' && (
              <KitchenWorkspace
                session={session}
                kernel={sdk}
                orders={orders}
                onUpdateOrderStatus={handleUpdateOrderStatus}
              />
            )}

            {session.role === 'MANAGER' && (
              <ManagerWorkspace
                session={session}
                kernel={sdk}
                orders={orders}
                products={products}
                onUpdateProducts={handleUpdateProducts}
                staffList={staffList}
                onUpdateStaff={handleUpdateStaff}
                vatConfig={vatConfig}
                onUpdateVatConfig={handleUpdateVatConfig}
                suppliers={suppliers}
                onUpdateSuppliers={handleUpdateSuppliers}
                restockRequests={restockRequests}
                onUpdateRestockRequests={handleUpdateRestockRequests}
                customers={customers}
                onUpdateCustomers={handleUpdateCustomers}
                onVoidOrder={handleVoidOrder}
              />
            )}

            {session.role === 'OWNER' && (
              <OwnerWorkspace
                session={session}
                kernel={sdk}
                orders={orders}
                products={products}
                onUpdateProducts={handleUpdateProducts}
                staffList={staffList}
                onUpdateStaff={handleUpdateStaff}
                vatConfig={vatConfig}
                onUpdateVatConfig={handleUpdateVatConfig}
                suppliers={suppliers}
                onUpdateSuppliers={handleUpdateSuppliers}
                restockRequests={restockRequests}
                onUpdateRestockRequests={handleUpdateRestockRequests}
                customers={customers}
                onUpdateCustomers={handleUpdateCustomers}
                branches={branches}
                onVoidOrder={handleVoidOrder}
              />
            )}

            {session.role === 'ADMINISTRATOR' && (
              <AdminWorkspace
                session={session}
                kernel={sdk}
                kernelEvents={kernelEvents}
              />
            )}
            </Suspense>
          </main>
        </>
      )}

    </div>
  );
}

export default function App() {
  return (
    <PlugOSProvider sdk={sdk}>
      <MainOSApp />
    </PlugOSProvider>
  );
}
