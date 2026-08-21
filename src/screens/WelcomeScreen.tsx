import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Store, User, Lock, Mail, Building2, Phone, Key, Smartphone, X } from 'lucide-react';
import { sdk } from '@plugos/sdk';
import { pairDeviceWithCode, getDeviceBootstrap } from '../lib/security';
import { getOrCreateDeviceId } from '../lib/deviceIdentity';
import { MarketingLanding } from './MarketingLanding';

export interface BusinessAuthSession {
  businessId: string;
  businessName: string;
  branchId?: string;
  branchName?: string;
  ownerId: string;
  isOwner: boolean;
  deviceId?: string;
}

interface WelcomeScreenProps {
  onLoginSuccess: (session: BusinessAuthSession) => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onLoginSuccess }) => {
  const [view, setView] = useState<'LOGIN' | 'CREATE' | 'PAIR'>('LOGIN');
  const [accessOpen, setAccessOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  
  // Create Business Fields
  const [businessName, setBusinessName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [businessType, setBusinessType] = useState('Takeaway');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Pair Device Fields
  const [pairingCode, setPairingCode] = useState('');
  const [deviceNameInput, setDeviceNameInput] = useState('');
  const [deviceTypeSelect, setDeviceTypeSelect] = useState<'CASHIER' | 'KITCHEN' | 'MANAGER'>('CASHIER');
  
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openAccess = (nextView: 'LOGIN' | 'CREATE' | 'PAIR') => {
    setView(nextView);
    setError(null);
    setAccessOpen(true);
  };

  useEffect(() => {
    if (!accessOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) setAccessOpen(false);
    };

    document.body.classList.add('plug-no-scroll');
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.classList.remove('plug-no-scroll');
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [accessOpen, loading]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!email.trim()) {
      setError('Email address is required.');
      setLoading(false);
      return;
    }

    if (!password) {
      setError('Password is required.');
      setLoading(false);
      return;
    }

    try {
      console.log('[AUTH_LOGIN] Initiating sign-in for email:', email.trim());
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (authError) {
        console.error('[AUTH_LOGIN] Supabase Auth error:', authError.message);
        throw authError;
      }

      if (!data.user) {
        throw new Error('Authentication failed: No user context returned.');
      }

      console.log('[AUTH_LOGIN] User authenticated successfully. Auth User ID:', data.user.id);

      // Query membership relationship
      console.log('[BUSINESS_RESTORE] Querying business_memberships for user_id:', data.user.id);
      const { data: memberData, error: memberError } = await supabase
        .from('business_memberships')
        .select('business_id, role, businesses(id, name, onboarding_status, owner_id)')
        .eq('user_id', data.user.id)
        .maybeSingle();

      if (memberError) {
        console.error('[BUSINESS_RESTORE] Error querying membership:', memberError.message);
        throw new Error('Database error querying business membership: ' + memberError.message);
      }

      let bizId = '';
      let bizName = '';
      let onboardingStatus = 'NOT_STARTED';

      if (memberData && memberData.business_id) {
        bizId = memberData.business_id;
        const bizObj = memberData.businesses as any;
        bizName = bizObj?.name || '';
        onboardingStatus = bizObj?.onboarding_status || 'NOT_STARTED';
        console.log('[BUSINESS_RESTORE] Resolved membership record:', {
          business_id: bizId,
          business_name: bizName,
          role: memberData.role,
          onboarding_status: onboardingStatus,
        });
      } else {
        // Fallback: Check businesses table directly for owner_id
        console.log('[BUSINESS_RESTORE] No membership row found. Querying businesses for owner_id:', data.user.id);
        const { data: bData, error: bError } = await supabase
          .from('businesses')
          .select('id, name, onboarding_status, owner_id')
          .eq('owner_id', data.user.id)
          .maybeSingle();

        if (bError) {
          console.error('[BUSINESS_RESTORE] Error querying businesses table:', bError.message);
          throw new Error('Database error querying business record: ' + bError.message);
        }

        if (bData) {
          bizId = bData.id;
          bizName = bData.name;
          onboardingStatus = bData.onboarding_status || 'NOT_STARTED';
          console.log('[BUSINESS_RESTORE] Resolved business by owner_id:', {
            business_id: bizId,
            business_name: bizName,
            onboarding_status: onboardingStatus,
          });
        }
      }

      if (!bizId) {
        throw new Error('No business account found for this user. Please register a new business.');
      }

      // Query initial branch
      console.log('[BRANCH_RESTORE] Querying branches for business_id:', bizId);
      const { data: branchData, error: branchError } = await supabase
        .from('branches')
        .select('id, name')
        .eq('business_id', bizId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (branchError) {
        console.error('[BRANCH_RESTORE] Error querying branches:', branchError.message);
        throw new Error('Database error querying branch: ' + branchError.message);
      }

      if (!branchData) {
        throw new Error('No active branch found for this business.');
      }

      console.log('[BRANCH_RESTORE] Resolved active branch:', {
        branch_id: branchData.id,
        branch_name: branchData.name,
      });

      const bAuth: BusinessAuthSession = {
        businessId: bizId,
        businessName: bizName,
        branchId: branchData.id,
        branchName: branchData.name,
        ownerId: data.user.id,
        isOwner: true,
        deviceId: getOrCreateDeviceId()
      };

      console.log('[AUTH_LOGIN] Session restoration complete for owner_id:', data.user.id);
      onLoginSuccess(bAuth);
    } catch (err: any) {
      console.error('[AUTH_LOGIN] Sign-in failed:', err.message);
      setError(err.message || 'Failed to sign in');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const trimmedOwnerName = ownerName.trim();
    const trimmedBizName = businessName.trim();
    const trimmedBranchName = branchName.trim();
    const trimmedEmail = email.trim();

    if (!trimmedOwnerName) {
      setError('Owner name is required.');
      setLoading(false);
      return;
    }

    if (!trimmedEmail) {
      setError('Email address is required.');
      setLoading(false);
      return;
    }

    if (!trimmedBizName) {
      setError('Business name is required.');
      setLoading(false);
      return;
    }

    if (!trimmedBranchName) {
      setError('First branch name is required.');
      setLoading(false);
      return;
    }

    if (password !== confirmPassword) {
      setError('Password and Confirm Password do not match.');
      setLoading(false);
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      setLoading(false);
      return;
    }

    try {
      console.log('[AUTH_SIGNUP] Creating new owner account for email:', trimmedEmail);

      // 1. Sign up user via Supabase Auth
      const { data, error: authError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
      });

      if (authError) {
        console.error('[AUTH_SIGNUP] Supabase Auth signup error:', authError.message);
        throw authError;
      }

      if (!data.user) {
        throw new Error('User creation failed: No user returned from authentication server.');
      }

      console.log('[AUTH_SIGNUP] Supabase Auth account created. User ID:', data.user.id);

      // 2. Invoke authoritative initialization RPC
      console.log('[BUSINESS_INIT_RPC] Invoking public.create_business_with_owner_and_branch with:', {
        business_name: trimmedBizName,
        branch_name: trimmedBranchName,
      });

      const { data: rpcData, error: rpcError } = await supabase.rpc('create_business_with_owner_and_branch', {
        business_name: trimmedBizName,
        branch_name: trimmedBranchName,
        branch_location: 'Primary Location'
      });

      if (rpcError) {
        console.error('[BUSINESS_INIT_RPC] RPC Execution Failed:', rpcError.message);
        throw new Error('Failed to create business database record: ' + rpcError.message);
      }

      if (!rpcData) {
        console.error('[BUSINESS_INIT_RPC] RPC returned empty result.');
        throw new Error('Business initialization RPC returned no data.');
      }

      const result = rpcData as any;
      const createdBusinessId = result.business_id;
      const createdBranchId = result.branch_id;

      if (!createdBusinessId || !createdBranchId) {
        console.error('[BUSINESS_INIT_RPC] Missing IDs in RPC response:', result);
        throw new Error('Initialization RPC response missing required business_id or branch_id.');
      }

      console.log('[BUSINESS_INIT_RPC] Business & Branch initialized successfully:', {
        business_id: createdBusinessId,
        branch_id: createdBranchId,
      });

      // 3. Update onboarding_status = IN_PROGRESS
      console.log('[ONBOARDING_STATUS] Updating businesses.onboarding_status = IN_PROGRESS for business_id:', createdBusinessId);
      const { error: updateErr } = await supabase
        .from('businesses')
        .update({ onboarding_status: 'IN_PROGRESS' })
        .eq('id', createdBusinessId);

      if (updateErr) {
        console.error('[ONBOARDING_STATUS] Failed to update onboarding status in cloud:', updateErr.message);
        throw new Error('Database error setting initial onboarding status: ' + updateErr.message);
      }

      const bAuth: BusinessAuthSession = {
        businessId: createdBusinessId,
        businessName: trimmedBizName,
        branchId: createdBranchId,
        branchName: trimmedBranchName,
        ownerId: data.user.id,
        isOwner: true,
        deviceId: getOrCreateDeviceId()
      };

      console.log('[AUTH_SIGNUP] Business creation complete. Launching onboarding wizard.');
      onLoginSuccess(bAuth);
    } catch (err: any) {
      console.error('[AUTH_SIGNUP] Business creation aborted due to error:', err.message);
      setError(err.message || 'Failed to create business.');
    } finally {
      setLoading(false);
    }
  };

  const handlePairDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (pairingCode.trim().length !== 6) {
        throw new Error('Pairing code must be exactly 6 digits.');
      }

      const currentDeviceId = getOrCreateDeviceId();
      const deviceName = deviceNameInput.trim() || `${deviceTypeSelect} Terminal`;

      // 1. R002 RPC Enrollment
      const pairRes = await pairDeviceWithCode(
        pairingCode.trim(),
        currentDeviceId,
        deviceName,
        deviceTypeSelect
      );

      if (!pairRes.success || !pairRes.businessId || !pairRes.branchId) {
        throw new Error(pairRes.error || 'Invalid or expired enrollment code.');
      }

      // 2. R002 Secure Bootstrap
      const bootstrap = await getDeviceBootstrap(currentDeviceId);

      if (!bootstrap.success || !bootstrap.business || !bootstrap.branch) {
        throw new Error(bootstrap.error || 'Failed to retrieve terminal bootstrap configuration.');
      }

      // 3. Populate local storage cache (credential-free)
      await sdk.storage.set('businesses', bootstrap.business.id, bootstrap.business);
      await sdk.storage.set('businesses', 'current', bootstrap.business);
      if (bootstrap.branch) {
        await sdk.storage.set('branches', 'directory', [bootstrap.branch]);
      }
      if (bootstrap.staff) {
        await sdk.storage.set('staff', 'directory', bootstrap.staff);
      }
      if (bootstrap.products) {
        await sdk.storage.set('catalog', 'products', bootstrap.products);
      }

      const enrollmentRecord = {
        deviceId: currentDeviceId,
        businessId: pairRes.businessId,
        businessName: bootstrap.business.name || 'Paired Business',
        branchId: pairRes.branchId,
        branchName: bootstrap.branch.name || 'Branch',
        deviceName,
        deviceType: deviceTypeSelect,
        status: 'ACTIVE',
        enrolledAt: new Date().toISOString()
      };
      localStorage.setItem('plugos_enrollment', JSON.stringify(enrollmentRecord));

      const bAuth: BusinessAuthSession = {
        businessId: pairRes.businessId,
        businessName: bootstrap.business.name || 'Paired Business',
        branchId: pairRes.branchId,
        branchName: bootstrap.branch.name || 'Branch',
        ownerId: bootstrap.business.owner_id || '',
        isOwner: false,
        deviceId: currentDeviceId
      };

      setPairingCode('');

      onLoginSuccess(bAuth);
    } catch (err: any) {
      setError(err.message || 'Failed to pair device.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <MarketingLanding
        onSignIn={() => openAccess('LOGIN')}
        onCreateBusiness={() => openAccess('CREATE')}
        onPairDevice={() => openAccess('PAIR')}
      />

      {accessOpen && (
        <div
          className="fixed inset-0 bg-slate-950/70 backdrop-blur-md flex items-stretch justify-end z-50"
          onMouseDown={() => { if (!loading) setAccessOpen(false); }}
        >
      <div
        className="plug-access-panel bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plug-access-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="plug-access-head bg-slate-950 p-6 border-b border-slate-800 flex flex-col items-center justify-center space-y-3 shrink-0">
          <button
            className="plug-access-close"
            type="button"
            onClick={() => setAccessOpen(false)}
            aria-label="Close business access"
          >
            <X aria-hidden="true" />
          </button>
          <div className="w-16 h-16 bg-amber-500 rounded-2xl flex items-center justify-center shadow-lg shadow-amber-500/20">
            <Store className="w-8 h-8 text-slate-950" />
          </div>
          <h2 id="plug-access-title" className="text-2xl font-black text-white tracking-tight">ThePlugOS</h2>
          <p className="text-sm font-bold text-slate-500 tracking-widest uppercase">Operating System</p>
        </div>

        <div className="plug-access-body p-6 overflow-y-auto">
          {/* Tabs */}
          <div className="plug-access-tabs flex bg-slate-950 rounded-xl p-1 mb-6 border border-slate-800 shrink-0">
            <button
              type="button"
              onClick={() => { setView('LOGIN'); setError(null); }}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${
                view === 'LOGIN' ? 'bg-amber-500 text-slate-950 shadow-md' : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => { setView('CREATE'); setError(null); }}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${
                view === 'CREATE' ? 'bg-amber-500 text-slate-950 shadow-md' : 'text-slate-400 hover:text-white'
              }`}
            >
              Create Business
            </button>
            <button
              type="button"
              onClick={() => { setView('PAIR'); setError(null); }}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${
                view === 'PAIR' ? 'bg-amber-500 text-slate-950 shadow-md' : 'text-slate-400 hover:text-white'
              }`}
            >
              Pair Device
            </button>
          </div>

          {error && (
            <div role="alert" className="mb-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl font-bold text-center">
              {error}
            </div>
          )}

          {view === 'LOGIN' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="plug-login-email" className="text-xs font-bold text-slate-400">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="Enter email"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="plug-login-password" className="text-xs font-bold text-slate-400">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-login-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="Enter password"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-3 rounded-xl transition-all shadow-md mt-2 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Signing In...' : 'Sign In'}
              </button>
            </form>
          )}
          
          {view === 'CREATE' && (
            <form onSubmit={handleCreateBusiness} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="plug-create-business" className="text-xs font-bold text-slate-400">Business Name</label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-create-business"
                    type="text"
                    required
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="e.g. Nomsa's Takeaway"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="plug-create-branch" className="text-xs font-bold text-slate-400">First Branch Name</label>
                <div className="relative">
                  <Store className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-create-branch"
                    type="text"
                    required
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="e.g. Cresta Branch"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="plug-create-owner" className="text-xs font-bold text-slate-400">Owner Name</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-create-owner"
                    type="text"
                    required
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="e.g. Nomsa"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="plug-create-phone" className="text-xs font-bold text-slate-400">Phone Number</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-create-phone"
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="e.g. 0821234567"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="plug-create-type" className="text-xs font-bold text-slate-400">Business Type</label>
                <div className="relative">
                  <Store className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <select
                    id="plug-create-type"
                    value={businessType}
                    onChange={(e) => setBusinessType(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500 appearance-none"
                  >
                    <option value="Takeaway">Takeaway / Fast Food</option>
                    <option value="Spaza">Spaza / Grocery Store</option>
                    <option value="Bakery">Bakery</option>
                    <option value="Butchery">Butchery</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="plug-create-email" className="text-xs font-bold text-slate-400">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-create-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="Enter email"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="plug-create-password" className="text-xs font-bold text-slate-400">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-create-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="Create a password"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="plug-create-confirm" className="text-xs font-bold text-slate-400">Confirm Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-create-confirm"
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500"
                    placeholder="Re-enter password"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-3 rounded-xl transition-all shadow-md mt-2 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Creating Business...' : 'Create Business'}
              </button>
            </form>
          )}

          {view === 'PAIR' && (
            <form onSubmit={handlePairDevice} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="plug-pair-code" className="text-xs font-bold text-slate-400">6-Digit Pairing Code</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-pair-code"
                    type="text"
                    required
                    maxLength={6}
                    value={pairingCode}
                    onChange={(e) => setPairingCode(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-white text-lg tracking-widest font-mono focus:outline-none focus:border-amber-500 text-center"
                    placeholder="------"
                  />
                </div>
                <p className="text-[10px] text-slate-500 text-center pt-1">
                  Get this 6-digit code from the Owner Dashboard on an active device.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="plug-pair-device-name" className="text-xs font-bold text-slate-400">Device Name</label>
                <div className="relative">
                  <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    id="plug-pair-device-name"
                    type="text"
                    value={deviceNameInput}
                    onChange={(e) => setDeviceNameInput(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-white text-xs focus:outline-none focus:border-amber-500"
                    placeholder="e.g. Counter Cashier Tablet"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="plug-pair-device-type" className="text-xs font-bold text-slate-400">Device Type / Role</label>
                <select
                  id="plug-pair-device-type"
                  value={deviceTypeSelect}
                  onChange={(e) => setDeviceTypeSelect(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-white text-xs focus:outline-none focus:border-amber-500"
                >
                  <option value="CASHIER">Cashier Terminal POS</option>
                  <option value="KITCHEN">Kitchen Order Screen (KDS)</option>
                  <option value="MANAGER">Manager Supervisor Tablet</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={loading || pairingCode.length < 6}
                className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-3 rounded-xl transition-all shadow-md mt-2 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Validating & Pairing...' : 'Pair & Join Business'}
              </button>
            </form>
          )}
        </div>
      </div>
        </div>
      )}
    </>
  );
};
