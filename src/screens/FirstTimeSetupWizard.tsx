import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { sdk } from '@plugos/sdk';
import { setStaffPin } from '../lib/security';
import { Building2, UserPlus, FileText, CheckCircle2, ChevronRight, Settings } from 'lucide-react';
import { StaffMember, ProductItem, Branch, PendingStaffSetup } from '../types';

interface FirstTimeSetupWizardProps {
  businessAuth: { businessId: string; businessName?: string; branchId: string; branchName: string; isOwner: boolean; ownerId?: string };
  onComplete: () => void;
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const FirstTimeSetupWizard: React.FC<FirstTimeSetupWizardProps> = ({ businessAuth, onComplete }) => {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);

  // Step 1 State
  const [ownerPin, setOwnerPin] = useState('');
  const [confirmOwnerPin, setConfirmOwnerPin] = useState('');
  const [ownerPinError, setOwnerPinError] = useState('');

  const [pendingStaffList, setPendingStaffList] = useState<PendingStaffSetup[]>([]);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffRole, setNewStaffRole] = useState<'MANAGER' | 'CASHIER' | 'KITCHEN_STAFF'>('CASHIER');
  const [newStaffPin, setNewStaffPin] = useState('');

  // Step 2 State
  const [menuItems, setMenuItems] = useState<ProductItem[]>([]);
  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemUnit, setNewItemUnit] = useState('Each');
  const [newItemStock, setNewItemStock] = useState('0');

  const handleAddStaff = () => {
    if (!newStaffName.trim()) {
      alert('Please enter employee name.');
      return;
    }
    if (!/^\d{4}$/.test(newStaffPin)) {
      alert('PIN must be exactly 4 digits.');
      return;
    }
    const newStaff: StaffMember = {
      id: generateUUID(),
      name: newStaffName,
      role: newStaffRole,
      branchId: businessAuth.branchId,
      activeShift: false,
      performanceScore: 100
    };
    setPendingStaffList([...pendingStaffList, { staff: newStaff, pin: newStaffPin }]);
    setNewStaffName('');
    setNewStaffPin('');
  };

  const handleAddMenu = () => {
    if (!newItemName || !newItemPrice) return;
    const newItem: ProductItem = {
      id: generateUUID(),
      name: newItemName,
      description: newItemName,
      price: parseFloat(newItemPrice) || 0,
      costPrice: (parseFloat(newItemPrice) || 0) * 0.6,
      category: 'General',
      domain: 'fastfood-domain',
      stock: parseFloat(newItemStock) || 0,
      unit: newItemUnit || 'Each',
      status: 'ACTIVE'
    };
    setMenuItems([...menuItems, newItem]);
    setNewItemName('');
    setNewItemPrice('');
    setNewItemStock('0');
  };

  const handleCompleteSetup = async () => {
    setOnboardingError(null);

    if (!ownerPin || ownerPin.length < 4) {
      alert('Please set a 4-digit Owner PIN in Step 1.');
      setStep(1);
      return;
    }
    if (ownerPin !== confirmOwnerPin) {
      alert('Owner PINs do not match. Please verify in Step 1.');
      setStep(1);
      return;
    }

    setLoading(true);
    try {
      // 1. Verify authenticated session & identities strictly
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) {
        console.error('[ONBOARDING_AUTH_CHECK_FAILURE]', authError);
        throw new Error('Onboarding failed: Authenticated owner session is missing or expired. Please log in again.');
      }

      const currentOwnerId = user.id;

      if (businessAuth.ownerId && businessAuth.ownerId !== user.id) {
        console.error('[ONBOARDING_IDENTITY_MISMATCH]', {
          businessAuth_ownerId: businessAuth.ownerId,
          auth_user_id: user.id
        });
        throw new Error(`Onboarding failed: Identity mismatch (Context owner '${businessAuth.ownerId}' does not match authenticated user ID '${user.id}').`);
      }

      if (!businessAuth.businessId) {
        throw new Error('Onboarding failed: Business identity is missing in setup context.');
      }

      if (!businessAuth.branchId || !businessAuth.branchName) {
        throw new Error('Onboarding failed: Branch identity (branchId or branchName) is missing in setup context.');
      }

      // 2. Prepare Staff Records (Owner + Employees)
      const ownerPending: PendingStaffSetup = {
        staff: {
          id: currentOwnerId,
          name: 'Business Owner',
          role: 'OWNER',
          branchId: businessAuth.branchId,
          activeShift: true,
          performanceScore: 100
        },
        pin: ownerPin
      };

      const fullPendingList: PendingStaffSetup[] = [ownerPending, ...pendingStaffList];

      // 3. CLOUD-FIRST STAFF WRITES TO SUPABASE
      for (const item of fullPendingList) {
        const { staff, pin } = item;
        console.log('[ONBOARDING_STAFF_WRITE_ATTEMPT]', {
          business_id: businessAuth.businessId,
          branch_id: businessAuth.branchId,
          staff_id: staff.id,
          staff_name: staff.name,
          staff_role: staff.role
        });

        const staffPayload = {
          id: staff.id,
          business_id: businessAuth.businessId,
          branch_id: businessAuth.branchId,
          name: staff.name,
          role: staff.role,
          status: 'ACTIVE',
          active_shift: staff.activeShift ?? false,
          performance_score: staff.performanceScore ?? 100
        };

        const { error: staffErr } = await supabase
          .from('staff_members')
          .upsert([staffPayload]);

        if (staffErr) {
          console.error('[ONBOARDING_STAFF_WRITE_FAILURE]', {
            code: staffErr.code,
            message: staffErr.message,
            details: staffErr.details,
            hint: staffErr.hint
          });
          throw new Error(`Setup could not be completed: staff record '${staff.name}' failed to save. [${staffErr.code}] ${staffErr.message}`);
        }

        if (pin) {
          await setStaffPin(staff.id, businessAuth.businessId, businessAuth.branchId, pin);
        }

        console.log('[ONBOARDING_STAFF_WRITE_SUCCESS]', {
          staff_id: staff.id,
          staff_name: staff.name
        });
      }

      // 4. CLOUD-FIRST CATALOG WRITES TO SUPABASE
      for (const item of menuItems) {
        console.log('[ONBOARDING_PRODUCT_WRITE_ATTEMPT]', {
          business_id: businessAuth.businessId,
          branch_id: businessAuth.branchId,
          product_id: item.id,
          product_name: item.name
        });

        const productPayload = {
          id: item.id,
          business_id: businessAuth.businessId,
          branch_id: businessAuth.branchId,
          name: item.name,
          category: item.category,
          price: item.price,
          description: item.description || null,
          stock_quantity: item.stock ?? 0,
          unit_of_measure: item.unit || 'Each',
          cost_price: item.costPrice ?? null,
          status: item.status || 'ACTIVE'
        };

        const { error: prodErr } = await supabase
          .from('catalog_products')
          .upsert([productPayload]);

        if (prodErr) {
          console.error('[ONBOARDING_PRODUCT_WRITE_FAILURE]', {
            code: prodErr.code,
            message: prodErr.message,
            details: prodErr.details,
            hint: prodErr.hint
          });
          throw new Error(`Setup could not be completed: catalog product '${item.name}' failed to save. [${prodErr.code}] ${prodErr.message}`);
        }

        console.log('[ONBOARDING_PRODUCT_WRITE_SUCCESS]', {
          product_id: item.id,
          product_name: item.name
        });
      }

      // 5. CLOUD-FIRST ONBOARDING STATUS COMPLETION UPDATE
      console.log('[ONBOARDING_COMPLETION_ATTEMPT]', { business_id: businessAuth.businessId });

      const { error: bizErr } = await supabase
        .from('businesses')
        .update({ onboarding_status: 'COMPLETED' })
        .eq('id', businessAuth.businessId);

      if (bizErr) {
        console.error('[ONBOARDING_COMPLETION_FAILURE]', {
          code: bizErr.code,
          message: bizErr.message,
          details: bizErr.details,
          hint: bizErr.hint
        });
        throw new Error(`Setup could not be completed: business completion status failed to save. [${bizErr.code}] ${bizErr.message}`);
      }

      console.log('[ONBOARDING_COMPLETION_SUCCESS]', { business_id: businessAuth.businessId });

      // 6. UPDATE LOCAL CACHE ONLY AFTER ALL CLOUD WRITES ARE PROVEN
      const cleanStaffList: StaffMember[] = fullPendingList.map(p => p.staff);

      const mainBranch: Branch = {
        id: businessAuth.branchId,
        name: businessAuth.branchName,
        location: 'Primary Store',
        domain: 'fastfood-domain',
        isActive: true
      };

      await sdk.storage.set('branches', 'directory', [mainBranch]);
      await sdk.storage.set('branches', mainBranch.id, mainBranch);

      await sdk.storage.set('staff', 'directory', cleanStaffList);
      for (const staff of cleanStaffList) {
        await sdk.storage.set('staff', staff.id, staff);
      }

      await sdk.storage.set('catalog', 'products', menuItems);
      for (const item of menuItems) {
        await sdk.storage.set('catalog', item.id, item);
      }

      const bizRecord = {
        id: businessAuth.businessId,
        name: businessAuth.businessName || 'My Business',
        ownerId: ownerPending.staff.id,
        onboarding_status: 'COMPLETED' as const,
        createdAt: new Date().toISOString()
      };
      await sdk.storage.set('businesses', bizRecord.id, bizRecord);
      await sdk.storage.set('businesses', 'current', bizRecord);

      const vatConfig = { enabled: false, rate: 15 };
      await sdk.storage.set('config', 'vat', vatConfig);

      const setupSettings = { completed: true, completedAt: new Date().toISOString() };
      await sdk.storage.set('config', 'settings', setupSettings);

      console.log('[ONBOARDING_FLOW_COMPLETE] Onboarding persistence verified. Launching terminal.');
      onComplete();
    } catch (e: any) {
      console.error('[ONBOARDING_FATAL_ERROR]', e);
      setOnboardingError(e.message || 'Setup could not be completed: unexpected system error.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="plug-setup-gate fixed inset-0 bg-[#020617] flex items-center justify-center z-50 p-4">
      <div className="plug-setup-card bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        <div className="plug-setup-head bg-slate-950 p-6 border-b border-slate-800 shrink-0">
          <h2 className="text-2xl font-black text-white tracking-tight">Business Setup</h2>
          <p className="text-sm text-slate-400 mt-1">Let's get your business ready for operation</p>
          
          <div className="flex items-center gap-4 mt-6">
            <div className={`flex items-center gap-2 ${step >= 1 ? 'text-amber-500' : 'text-slate-600'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold border-2 ${step >= 1 ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 bg-slate-800'}`}>1</div>
              <span className="text-xs font-bold hidden sm:block">Team &amp; access</span>
            </div>
            <div className={`h-0.5 flex-1 ${step >= 2 ? 'bg-amber-500/50' : 'bg-slate-800'}`} />
            <div className={`flex items-center gap-2 ${step >= 2 ? 'text-amber-500' : 'text-slate-600'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold border-2 ${step >= 2 ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 bg-slate-800'}`}>2</div>
              <span className="text-xs font-bold hidden sm:block">Products</span>
            </div>
            <div className={`h-0.5 flex-1 ${step >= 3 ? 'bg-amber-500/50' : 'bg-slate-800'}`} />
            <div className={`flex items-center gap-2 ${step >= 3 ? 'text-amber-500' : 'text-slate-600'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold border-2 ${step >= 3 ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 bg-slate-800'}`}>3</div>
              <span className="text-xs font-bold hidden sm:block">Review</span>
            </div>
          </div>
        </div>

        <div className="plug-setup-body p-6 overflow-y-auto flex-1">
          {onboardingError && (
            <div className="mb-6 p-4 bg-rose-950/80 border border-rose-800 rounded-2xl text-rose-200 text-xs font-semibold flex items-center justify-between">
              <div>
                <span className="font-bold text-rose-400 block mb-0.5">We couldn&apos;t save your setup</span>
                {onboardingError}
              </div>
              <button
                type="button"
                onClick={() => setOnboardingError(null)}
                className="text-rose-400 hover:text-white text-xs font-bold underline shrink-0 ml-3"
              >
                Dismiss
              </button>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              {/* Owner PIN Setup */}
              <div className="bg-slate-950 p-4 border border-amber-500/30 rounded-2xl space-y-3">
                <h4 className="text-sm font-bold text-amber-400 flex items-center gap-2">
                  <Building2 className="w-4 h-4" /> Secure owner access
                </h4>
                <p className="text-xs text-slate-400">
                  Choose a private four-digit PIN for the owner profile. Avoid easy patterns such as 1234.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="plug-owner-pin" className="text-[11px] text-slate-400 font-semibold block mb-1">Create owner PIN</label>
                    <input
                      id="plug-owner-pin"
                      type="password"
                      maxLength={4}
                      placeholder="e.g. 5829"
                      value={ownerPin}
                      onChange={(e) => setOwnerPin(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono text-center text-sm font-bold focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label htmlFor="plug-owner-pin-confirm" className="text-[11px] text-slate-400 font-semibold block mb-1">Confirm owner PIN</label>
                    <input
                      id="plug-owner-pin-confirm"
                      type="password"
                      maxLength={4}
                      placeholder="Re-enter PIN"
                      value={confirmOwnerPin}
                      onChange={(e) => setConfirmOwnerPin(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono text-center text-sm font-bold focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>
                {ownerPin && confirmOwnerPin && ownerPin !== confirmOwnerPin && (
                  <p role="alert" className="text-[10px] text-rose-400 font-bold">The two PINs do not match.</p>
                )}
              </div>

              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <UserPlus className="w-5 h-5 text-amber-500" />
                  Add your team
                </h3>
                <p className="text-sm text-slate-400 mt-1">Create profiles and PINs for your staff to log into the terminal.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input
                  aria-label="Staff member name"
                  type="text"
                  placeholder="Name"
                  value={newStaffName}
                  onChange={(e) => setNewStaffName(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-amber-500"
                />
                <select
                  aria-label="Staff member role"
                  value={newStaffRole}
                  onChange={(e) => setNewStaffRole(e.target.value as any)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-amber-500"
                >
                  <option value="CASHIER">Cashier</option>
                  <option value="MANAGER">Manager</option>
                  <option value="KITCHEN_STAFF">Kitchen</option>
                </select>
                <input
                  aria-label="Staff member four-digit PIN"
                  inputMode="numeric"
                  type="text"
                  placeholder="4-digit PIN"
                  maxLength={4}
                  value={newStaffPin}
                  onChange={(e) => setNewStaffPin(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-amber-500"
                />
                <button
                  type="button"
                  onClick={handleAddStaff}
                  className="bg-amber-500 text-slate-950 font-bold py-2 px-4 rounded-xl hover:bg-amber-400 transition"
                >
                  Add
                </button>
              </div>

              {pendingStaffList.length > 0 && (
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                  <h4 className="text-xs font-bold text-slate-400 uppercase">Added Staff</h4>
                  {pendingStaffList.map(item => (
                    <div key={item.staff.id} className="flex justify-between items-center text-sm">
                      <span className="text-white font-semibold">{item.staff.name}</span>
                      <span className="text-slate-400">{item.staff.role}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end pt-4">
                <button
                  onClick={() => setStep(2)}
                  className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-3 px-6 rounded-xl flex items-center gap-2"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <FileText className="w-5 h-5 text-amber-500" />
                  Add products
                </h3>
                <p className="text-sm text-slate-400 mt-1">Add a few items to get started. You can add more later.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <input
                  aria-label="Product name"
                  type="text"
                  placeholder="Item Name (e.g. Kota)"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
                />
                <input
                  aria-label="Product price in rand"
                  type="number"
                  placeholder="Price (R)"
                  value={newItemPrice}
                  onChange={(e) => setNewItemPrice(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
                />
                <select
                  aria-label="Product unit"
                  value={newItemUnit}
                  onChange={(e) => setNewItemUnit(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
                >
                  <option value="Each">Each</option>
                  <option value="Kg">Kg</option>
                  <option value="Gram">Gram</option>
                  <option value="Litre">Litre</option>
                  <option value="Millilitre">Millilitre</option>
                  <option value="Pack">Pack</option>
                  <option value="Box">Box</option>
                  <option value="Tray">Tray</option>
                  <option value="Portion">Portion</option>
                </select>
                <input
                  aria-label="Opening stock quantity"
                  type="number"
                  placeholder="Opening Stock"
                  value={newItemStock}
                  onChange={(e) => setNewItemStock(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
                />
                <button
                  type="button"
                  onClick={handleAddMenu}
                  className="bg-amber-500 text-slate-950 font-bold py-2 px-4 rounded-xl hover:bg-amber-400 transition text-xs"
                >
                  Add Item
                </button>
              </div>

              {menuItems.length > 0 && (
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                  <h4 className="text-xs font-bold text-slate-400 uppercase">Products added</h4>
                  {menuItems.map(item => (
                    <div key={item.id} className="flex justify-between items-center text-sm">
                      <div>
                        <span className="text-white font-semibold">{item.name}</span>
                        <span className="text-slate-500 text-xs ml-2">({item.stock} {item.unit} stock)</span>
                      </div>
                      <span className="text-amber-400 font-bold">R {item.price.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-between pt-4">
                <button
                  onClick={() => setStep(1)}
                  className="text-slate-400 hover:text-white font-bold py-3 px-6 rounded-xl"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep(3)}
                  className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-3 px-6 rounded-xl flex items-center gap-2"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Settings className="w-5 h-5 text-amber-500" />
                  Review your setup
                </h3>
                <p className="text-sm text-slate-400 mt-1">Review and finalize your setup.</p>
              </div>

              <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                  <span className="text-slate-200">Business details ready</span>
                </div>
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                  <span className="text-slate-200">{pendingStaffList.length} team profiles added</span>
                </div>
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                  <span className="text-slate-200">{menuItems.length} products added</span>
                </div>
              </div>

              <div className="flex justify-between pt-4">
                <button
                  onClick={() => setStep(2)}
                  className="text-slate-400 hover:text-white font-bold py-3 px-6 rounded-xl"
                >
                  Back
                </button>
                <button
                  onClick={handleCompleteSetup}
                  disabled={loading}
                  className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-3 px-6 rounded-xl flex items-center gap-2 disabled:opacity-50"
                >
                  {loading ? 'Saving setup…' : 'Open ThePlugOS'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
