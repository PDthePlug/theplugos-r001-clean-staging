import { supabase } from '../lib/supabase';
import { sdk } from '@plugos/sdk';
import { OrderRecord, ProductItem, StaffMember, Branch } from '../types';
import { getOrCreateDeviceId } from '../lib/deviceIdentity';
import { mapStaffRowToStaffMember, mapCatalogProductRowToProductItem } from '../lib/mappers';

export type SyncStatus = 'SYNCED' | 'SYNCING' | 'OFFLINE' | 'ERROR';
export type RealtimeStatus = 'CONNECTING' | 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export interface SyncLogEntry {
  id: string;
  deviceId: string;
  businessId: string;
  direction: 'UP' | 'DOWN' | 'BROADCAST';
  entityType: 'order' | 'product' | 'staff' | 'branch' | 'device' | 'config' | 'all';
  entityId: string;
  operation: 'UPSERT' | 'DELETE' | 'FETCH' | 'STATUS_CHANGE';
  timestamp: string;
  status: 'SUCCESS' | 'FAILURE';
  error?: string;
}

export interface SyncListenerCallbacks {
  onOrdersUpdated?: (orders: OrderRecord[]) => void;
  onProductsUpdated?: (products: ProductItem[]) => void;
  onStaffUpdated?: (staff: StaffMember[]) => void;
  onBranchesUpdated?: (branches: Branch[]) => void;
  onStatusChanged?: (status: SyncStatus) => void;
  onLogAdded?: (log: SyncLogEntry) => void;
}

export class SyncService {
  private status: SyncStatus = 'SYNCED';
  private businessId: string = '';
  private branchId: string = '';
  private deviceId: string = 'dev-local';
  private logs: SyncLogEntry[] = [];
  private listeners: SyncListenerCallbacks[] = [];
  private broadcastChannel: BroadcastChannel | null = null;
  private realtimeChannel: any = null;
  private realtimeStatus: RealtimeStatus = 'CLOSED';

  constructor() {
    this.deviceId = getOrCreateDeviceId();

    const storedBiz = localStorage.getItem('plugos_business_auth');
    if (storedBiz) {
      try {
        const parsed = JSON.parse(storedBiz);
        if (parsed.businessId) this.businessId = parsed.businessId;
        if (parsed.branchId) this.branchId = parsed.branchId;
      } catch (e) {
        // fallback
      }
    }

    // Initialize BroadcastChannel for cross-tab multi-device simulation in same browser
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      this.broadcastChannel = new BroadcastChannel('plugos_live_sync_bus');
      this.broadcastChannel.onmessage = (event) => {
        this.handleIncomingBroadcast(event.data);
      };
    }

    // Initialize Supabase Realtime listener
    if (this.businessId) {
      this.initSupabaseRealtime();
    }
  }

  public setBusinessContext(businessId: string, branchId: string) {
    if (!businessId) return;
    this.businessId = businessId;
    this.branchId = branchId;
    this.initSupabaseRealtime();
    this.fetchAndSyncOrders();
    this.fetchAndSyncProducts();
    this.fetchAndSyncStaff();
  }

  public getStatus(): SyncStatus {
    return this.status;
  }

  public getRealtimeStatus(): RealtimeStatus {
    return this.realtimeStatus;
  }

  public getLogs(): SyncLogEntry[] {
    return this.logs;
  }

  public subscribe(callbacks: SyncListenerCallbacks) {
    this.listeners.push(callbacks);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callbacks);
    };
  }

  private notifyStatus(newStatus: SyncStatus) {
    this.status = newStatus;
    this.listeners.forEach(l => l.onStatusChanged?.(newStatus));
  }

  private logDiagnostic(entry: Omit<SyncLogEntry, 'id' | 'timestamp'>) {
    const fullLog: SyncLogEntry = {
      id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      ...entry
    };
    this.logs = [fullLog, ...this.logs.slice(0, 99)]; // Keep last 100 entries
    console.log(`[SYNC] Device: ${fullLog.deviceId} Business: ${fullLog.businessId} Entity: ${fullLog.entityType} Operation: ${fullLog.operation} Status: ${fullLog.status}${fullLog.error ? ` Error: ${fullLog.error}` : ''}`);
    this.listeners.forEach(l => l.onLogAdded?.(fullLog));
  }

  /**
   * Supabase Realtime Subscription Setup
   */
  private initSupabaseRealtime() {
    if (!supabase) return;
    try {
      if (this.realtimeChannel) {
        supabase.removeChannel(this.realtimeChannel);
      }

      const channelName = `sync:${this.businessId}`;
      this.realtimeStatus = 'CONNECTING';
      console.log(`[REALTIME_SUBSCRIBE] device_id=${this.deviceId} business_id=${this.businessId} branch_id=${this.branchId} channel=${channelName} status=CONNECTING`);

      this.realtimeChannel = supabase
        .channel(channelName)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
          this.handleCloudOrderChange(payload);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'catalog_products' }, (payload) => {
          this.handleCloudProductChange(payload);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_members' }, (payload) => {
          this.handleCloudStaffChange(payload);
        })
        .subscribe((status) => {
          this.realtimeStatus = status as RealtimeStatus;
          console.log(`[REALTIME_SUBSCRIBE] device_id=${this.deviceId} business_id=${this.businessId} branch_id=${this.branchId} channel=${channelName} status=${status}`);
          if (status === 'SUBSCRIBED') {
            this.notifyStatus('SYNCED');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            this.notifyStatus('ERROR');
          }
        });
    } catch (e) {
      console.warn('Realtime subscription fallback', e);
      this.realtimeStatus = 'CHANNEL_ERROR';
    }
  }

  /**
   * Handle BroadcastChannel incoming messages (cross-tab real-time sync)
   */
  private async handleIncomingBroadcast(data: any) {
    if (!data || data.senderDeviceId === this.deviceId) return; // Ignore self
    if (data.businessId && data.businessId !== this.businessId) return; // Ignore other business

    this.logDiagnostic({
      deviceId: data.senderDeviceId || 'remote-device',
      businessId: this.businessId,
      direction: 'DOWN',
      entityType: data.entityType,
      entityId: data.entityId || 'broadcast',
      operation: data.operation || 'UPSERT',
      status: 'SUCCESS'
    });

    if (data.entityType === 'order') {
      const currentOrders: OrderRecord[] = (await sdk.storage.get('orders', 'history')) || [];
      let updatedOrders: OrderRecord[];

      if (data.operation === 'UPSERT' || data.operation === 'STATUS_CHANGE') {
        const idx = currentOrders.findIndex(o => o.id === data.payload.id);
        if (idx >= 0) {
          currentOrders[idx] = data.payload;
          updatedOrders = [...currentOrders];
        } else {
          updatedOrders = [data.payload, ...currentOrders];
        }
      } else {
        updatedOrders = currentOrders;
      }

      await sdk.storage.set('orders', 'history', updatedOrders);
      this.listeners.forEach(l => l.onOrdersUpdated?.(updatedOrders));
    } else if (data.entityType === 'product') {
      const currentProducts: ProductItem[] = (await sdk.storage.get('catalog', 'products')) || [];
      let updatedProducts: ProductItem[];

      if (data.operation === 'UPSERT') {
        const idx = currentProducts.findIndex(p => p.id === data.payload.id);
        if (idx >= 0) {
          currentProducts[idx] = data.payload;
          updatedProducts = [...currentProducts];
        } else {
          updatedProducts = [data.payload, ...currentProducts];
        }
      } else if (data.operation === 'DELETE') {
        updatedProducts = currentProducts.filter(p => p.id !== data.payload.id);
      } else {
        updatedProducts = data.payload; // full array replace
      }

      await sdk.storage.set('catalog', 'products', updatedProducts);
      this.listeners.forEach(l => l.onProductsUpdated?.(updatedProducts));
    } else if (data.entityType === 'staff') {
      const currentStaff: StaffMember[] = (await sdk.storage.get('staff', 'directory')) || [];
      let updatedStaff: StaffMember[];

      if (Array.isArray(data.payload)) {
        updatedStaff = data.payload;
      } else {
        const idx = currentStaff.findIndex(s => s.id === data.payload.id);
        if (idx >= 0) {
          currentStaff[idx] = data.payload;
          updatedStaff = [...currentStaff];
        } else {
          updatedStaff = [data.payload, ...currentStaff];
        }
      }

      await sdk.storage.set('staff', 'directory', updatedStaff);
      this.listeners.forEach(l => l.onStaffUpdated?.(updatedStaff));
    }
  }

  private async handleCloudOrderChange(payload: any) {
    const record = payload.new || payload.old || {};
    const eventBizId = record.business_id || this.businessId;
    const eventBranchId = record.branch_id || this.branchId;
    const orderId = record.id || payload.new?.id || payload.old?.id || 'unknown-order';
    const eventType = payload.eventType || 'UPSERT';

    // Verify Business Scope
    if (record.business_id && record.business_id !== this.businessId) {
      console.log(`[REALTIME_FILTERED] Event for business ${record.business_id} ignored on device configured for ${this.businessId}`);
      return;
    }

    // Directive 018B Forensic Tag
    console.log(`[REALTIME_RECEIVE] device_id=${this.deviceId} business_id=${eventBizId} branch_id=${eventBranchId} order_id=${orderId} event_type=${eventType} timestamp=${new Date().toISOString()}`);

    this.logDiagnostic({
      deviceId: this.deviceId,
      businessId: this.businessId,
      direction: 'DOWN',
      entityType: 'order',
      entityId: orderId,
      operation: eventType,
      status: 'SUCCESS'
    });
    await this.fetchAndSyncOrders();
  }

  private async handleCloudProductChange(payload: any) {
    this.logDiagnostic({
      deviceId: this.deviceId,
      businessId: this.businessId,
      direction: 'DOWN',
      entityType: 'product',
      entityId: payload.new?.id || payload.old?.id || 'cloud-product',
      operation: payload.eventType || 'UPSERT',
      status: 'SUCCESS'
    });
    await this.fetchAndSyncProducts();
  }

  private async handleCloudStaffChange(payload: any) {
    this.logDiagnostic({
      deviceId: this.deviceId,
      businessId: this.businessId,
      direction: 'DOWN',
      entityType: 'staff',
      entityId: payload.new?.id || payload.old?.id || 'cloud-staff',
      operation: payload.eventType || 'UPSERT',
      status: 'SUCCESS'
    });
    await this.fetchAndSyncStaff();
  }

  /**
   * Log transactional audit event to persistent audit trail (Directive 012 Section 12)
   */
  public async logAuditEvent(event: {
    eventType: string;
    entityId: string;
    actorId: string;
    details?: Record<string, any>;
  }): Promise<void> {
    const auditRecord = {
      event_id: `evt-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      business_id: this.businessId,
      branch_id: this.branchId,
      device_id: this.deviceId,
      actor_id: event.actorId,
      timestamp: new Date().toISOString(),
      entity_id: event.entityId,
      event_type: event.eventType,
      details: event.details || {}
    };

    console.log(`[AUDIT TRAIL] Event: ${auditRecord.event_type} Entity: ${auditRecord.entity_id} Actor: ${auditRecord.actor_id}`);

    try {
      await supabase.from('audit_logs').insert(auditRecord);
    } catch (e) {
      // Graceful fallback if audit_logs table missing
    }
  }

  /**
   * Sync Order to Cloud & Broadcast channel
   */
  public async syncOrder(order: OrderRecord, operation: 'UPSERT' | 'STATUS_CHANGE' = 'UPSERT', oldState?: string): Promise<boolean> {
    this.notifyStatus('SYNCING');
    let cloudSuccess = false;
    let errorMsg = '';

    // 1. Broadcast locally (cross-tab dev simulation)
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        senderDeviceId: this.deviceId,
        businessId: this.businessId,
        entityType: 'order',
        entityId: order.id,
        operation,
        payload: order
      });
    }

    // 2. Persist to Supabase if available (Physical Multi-Device Source of Truth)
    try {
      const { error } = await supabase.from('orders').upsert({
        id: order.id,
        business_id: order.businessId || this.businessId,
        branch_id: order.branchId || this.branchId,
        device_id: order.deviceId || this.deviceId,
        cashier_id: order.cashierId,
        cashier_name: order.cashierName,
        customer_name: order.customerName || null,
        customer_phone: order.customerPhone || null,
        subtotal: order.subtotal,
        tax: order.tax,
        total_amount: order.totalAmount,
        payment_method: order.paymentMethod || order.paymentType,
        payment_status: 'PENDING',
        status: order.status,
        created_at: order.createdAt,
        updated_at: new Date().toISOString()
      });

      if (error) {
        errorMsg = error.message;
      } else {
        // Also persist order items
        if (order.items && order.items.length > 0) {
          const itemsPayload = order.items.map(item => ({
             order_id: order.id,
             product_id: (item as any).productId || (item as any).id || null,
             name: item.name,
             unit_price: item.price,
             quantity: item.quantity,
             line_total: item.price * item.quantity,
             notes: item.notes || null
          }));
          const { error: itemError } = await supabase.from('order_items').upsert(itemsPayload);
          if (itemError) {
             errorMsg = itemError.message;
          } else {
             cloudSuccess = true;
          }
        } else {
           cloudSuccess = true;
        }
      }
    } catch (e: any) {
      errorMsg = e.message;
    }

    // Directive 018B Forensic Tags
    console.log(`[ORDER_SYNC] device_id=${this.deviceId} business_id=${order.businessId || this.businessId} branch_id=${order.branchId || this.branchId} order_id=${order.id} event_type=${operation} timestamp=${new Date().toISOString()} Supabase_write=${cloudSuccess ? 'SUCCESS' : 'FAILURE'} Error=${errorMsg}`);

    if (operation === 'STATUS_CHANGE' || oldState) {
      console.log(`[ORDER_STATE_UPDATE] device_id=${this.deviceId} order_id=${order.id} old_state=${oldState || 'PREVIOUS'} new_state=${order.status} timestamp=${new Date().toISOString()}`);
    }

    this.logDiagnostic({
      deviceId: this.deviceId,
      businessId: this.businessId,
      direction: 'UP',
      entityType: 'order',
      entityId: order.id,
      operation,
      status: cloudSuccess ? 'SUCCESS' : 'FAILURE',
      error: errorMsg
    });

    if (cloudSuccess) {
      this.notifyStatus('SYNCED');
    } else {
      this.notifyStatus('ERROR');
    }
    
    return cloudSuccess;
  }

  /**
   * Sync Products array to Cloud & Broadcast channel
   */
  public async syncProducts(products: ProductItem[], singleProduct?: ProductItem): Promise<boolean> {
    this.notifyStatus('SYNCING');
    let cloudSuccess = false;
    let errorMsg = '';

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        senderDeviceId: this.deviceId,
        businessId: this.businessId,
        entityType: 'product',
        entityId: singleProduct ? singleProduct.id : 'all_products',
        operation: 'UPSERT',
        payload: products
      });
    }

    try {
      const payloadToUpsert = products.map(p => ({
        id: p.id,
        business_id: this.businessId,
        branch_id: this.branchId,
        name: p.name,
        price: p.price,
        cost_price: p.costPrice || 0,
        category: p.category,
        stock_quantity: p.stock,
        unit_of_measure: p.unit || 'unit',
        description: p.description,
        status: p.status
      }));

      const { error } = await supabase.from('catalog_products').upsert(payloadToUpsert);
      if (error) {
        errorMsg = error.message;
      } else {
        cloudSuccess = true;
      }
    } catch (e: any) {
      errorMsg = e.message;
    }

    this.logDiagnostic({
      deviceId: this.deviceId,
      businessId: this.businessId,
      direction: 'UP',
      entityType: 'product',
      entityId: singleProduct ? singleProduct.id : 'products_batch',
      operation: 'UPSERT',
      status: cloudSuccess ? 'SUCCESS' : 'FAILURE',
      error: errorMsg
    });

    if (cloudSuccess) {
      this.notifyStatus('SYNCED');
    } else {
      this.notifyStatus('ERROR');
    }
    
    return cloudSuccess;
  }

  /**
   * Sync Staff directory to Cloud & Broadcast channel
   */
  public async syncStaff(staffMembers: StaffMember[], singleMember?: StaffMember): Promise<boolean> {
    this.notifyStatus('SYNCING');
    let cloudSuccess = false;
    let errorMsg = '';

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        senderDeviceId: this.deviceId,
        businessId: this.businessId,
        entityType: 'staff',
        entityId: singleMember ? singleMember.id : 'all_staff',
        operation: 'UPSERT',
        payload: staffMembers
      });
    }

    try {
      const payloadToUpsert = staffMembers.map(s => ({
        id: s.id,
        business_id: this.businessId,
        branch_id: s.branchId || this.branchId,
        name: s.name,
        role: s.role,
        active_shift: s.activeShift,
        performance_score: s.performanceScore,
        status: 'ACTIVE'
      }));

      const { error } = await supabase.from('staff_members').upsert(payloadToUpsert);
      if (error) {
        errorMsg = error.message;
      } else {
        cloudSuccess = true;
      }
    } catch (e: any) {
      errorMsg = e.message;
    }

    this.logDiagnostic({
      deviceId: this.deviceId,
      businessId: this.businessId,
      direction: 'UP',
      entityType: 'staff',
      entityId: singleMember ? singleMember.id : 'staff_batch',
      operation: 'UPSERT',
      status: cloudSuccess ? 'SUCCESS' : 'FAILURE',
      error: errorMsg
    });

    if (cloudSuccess) {
      this.notifyStatus('SYNCED');
    } else {
      this.notifyStatus('ERROR');
    }
    
    return cloudSuccess;
  }

  /**
   * Fetch and sync Orders from Supabase
   */
  public async fetchAndSyncOrders(): Promise<OrderRecord[]> {
    this.notifyStatus('SYNCING');
    let orders: OrderRecord[] = [];

    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('business_id', this.businessId)
        .order('created_at', { ascending: false });

      if (!error && data && data.length > 0) {
        orders = data.map((row: any) => ({
          id: row.id,
          businessId: row.business_id,
          branchId: row.branch_id,
          deviceId: row.device_id,
          cashierId: row.cashier_id,
          cashierName: row.cashier_name,
          customerName: row.customer_name || undefined,
          customerPhone: row.customer_phone || undefined,
          subtotal: row.subtotal || row.total_amount,
          tax: row.tax || 0,
          total: row.total_amount,
          totalAmount: row.total_amount,
          paymentMethod: row.payment_method || 'CASH',
          paymentType: row.payment_method || 'CASH',
          status: row.status,
          items: [], // Left empty for MVP syncDown
          createdAt: row.created_at,
          updatedAt: row.updated_at || row.created_at
        }));

        await sdk.storage.set('orders', 'history', orders);
        this.listeners.forEach(l => l.onOrdersUpdated?.(orders));

        this.logDiagnostic({
          deviceId: this.deviceId,
          businessId: this.businessId,
          direction: 'DOWN',
          entityType: 'order',
          entityId: 'orders_fetch',
          operation: 'FETCH',
          status: 'SUCCESS'
        });
      }
    } catch (e) {
      this.logDiagnostic({
        deviceId: this.deviceId,
        businessId: this.businessId,
        direction: 'DOWN',
        entityType: 'order',
        entityId: 'orders_fetch',
        operation: 'FETCH',
        status: 'FAILURE',
        error: String(e)
      });
    }

    this.notifyStatus('SYNCED');
    return orders;
  }

  /**
   * Fetch and sync Products from Supabase
   */
  public async fetchAndSyncProducts(): Promise<ProductItem[]> {
    this.notifyStatus('SYNCING');
    let products: ProductItem[] = [];

    try {
      const { data, error } = await supabase
        .from('catalog_products')
        .select('*')
        .eq('business_id', this.businessId);

      if (!error && data && data.length > 0) {
        products = data.map(mapCatalogProductRowToProductItem);

        await sdk.storage.set('catalog', 'products', products);
        this.listeners.forEach(l => l.onProductsUpdated?.(products));

        this.logDiagnostic({
          deviceId: this.deviceId,
          businessId: this.businessId,
          direction: 'DOWN',
          entityType: 'product',
          entityId: 'products_fetch',
          operation: 'FETCH',
          status: 'SUCCESS'
        });
      }
    } catch (e) {
      // Fallback
    }

    this.notifyStatus('SYNCED');
    return products;
  }

  /**
   * Fetch and sync Staff from Supabase
   */
  public async fetchAndSyncStaff(): Promise<StaffMember[]> {
    this.notifyStatus('SYNCING');
    let staff: StaffMember[] = [];

    try {
      const { data, error } = await supabase
        .from('staff_members')
        .select('*')
        .eq('business_id', this.businessId);

      if (!error && data && data.length > 0) {
        staff = data.map(mapStaffRowToStaffMember);

        await sdk.storage.set('staff', 'directory', staff);
        this.listeners.forEach(l => l.onStaffUpdated?.(staff));

        this.logDiagnostic({
          deviceId: this.deviceId,
          businessId: this.businessId,
          direction: 'DOWN',
          entityType: 'staff',
          entityId: 'staff_fetch',
          operation: 'FETCH',
          status: 'SUCCESS'
        });
      }
    } catch (e) {
      // Fallback
    }

    this.notifyStatus('SYNCED');
    return staff;
  }
}

export const syncService = new SyncService();
