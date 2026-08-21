import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Store, Lock, Mail, Building2, X } from 'lucide-react';
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
  const [view, setView] = useState<'LOGIN' | 'CREATE'>('LOGIN');
  const [accessOpen, setAccessOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  
  // Create Business Fields
  const [businessName, setBusinessName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openAccess = (nextView: 'LOGIN' | 'CREATE') => {
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
        if (memberData.role !== 'OWNER') {
          throw new Error('This web shell accepts owner accounts only. Staff and manager station access is provided by the enrolled Android Cashier Hub.');
        }
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
        isOwner: true
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

    const trimmedBizName = businessName.trim();
    const trimmedBranchName = branchName.trim();
    const trimmedEmail = email.trim();

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
      if (!data.session) {
        throw new Error('Confirm your email, then sign in to create the business workspace. No business data was created yet.');
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

      // The R001 initializer intentionally leaves onboarding at NOT_STARTED.
      // Browser code must not promote a business to IN_PROGRESS/COMPLETED: the
      // native atomic onboarding command will do that only after staff and Hub
      // authority exist together.

      const bAuth: BusinessAuthSession = {
        businessId: createdBusinessId,
        businessName: trimmedBizName,
        branchId: createdBranchId,
        branchName: trimmedBranchName,
        ownerId: data.user.id,
        isOwner: true
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

  return (
    <>
      <MarketingLanding
        onSignIn={() => openAccess('LOGIN')}
        onCreateBusiness={() => openAccess('CREATE')}
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

        </div>
      </div>
        </div>
      )}
    </>
  );
};
