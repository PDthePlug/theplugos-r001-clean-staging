import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { localHubRuntime } from '@plugos/core';
import type { NetworkHealth } from '@plugos/core';
import type { Branch, StaffMember } from './types';
import { WelcomeScreen, type BusinessAuthSession } from './screens/WelcomeScreen';
import { supabase } from './lib/supabase';
import { mapBranchRowToBranch, mapStaffRowToStaffMember } from './lib/mappers';

const FirstTimeSetupWizard = lazy(() =>
  import('./screens/FirstTimeSetupWizard').then((module) => ({ default: module.FirstTimeSetupWizard }))
);
const RoleLoginModal = lazy(() =>
  import('./components/RoleLoginModal').then((module) => ({ default: module.RoleLoginModal }))
);
const NativeCashierStation = lazy(() =>
  import('./workspaces/NativeCashierStation').then((module) => ({ default: module.NativeCashierStation }))
);

const OperatingSurfaceLoading = () => (
  <div className="plug-surface-loading" role="status" aria-live="polite">
    <span aria-hidden="true" />
    <div>
      <strong>Preparing your workspace</strong>
      <small>Checking the approved operating context…</small>
    </div>
  </div>
);

const OwnerAccessProblem = ({ message, onSignOut }: { message: string; onSignOut: () => void }) => (
  <main className="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-slate-100">
    <section className="max-w-xl rounded-3xl border border-rose-500/30 bg-slate-900 p-7 shadow-2xl space-y-5" role="alert">
      <span className="inline-flex rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-200">Owner access unavailable</span>
      <div>
        <h1 className="text-xl font-bold">This browser cannot establish a safe business context.</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">{message}</p>
      </div>
      <p className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs leading-relaxed text-slate-400">
        Browser access is limited to an authenticated owner and read-only cloud foundation data. Station, staff, and device authority remain inside the enrolled Android Cashier Hub.
      </p>
      <button type="button" onClick={onSignOut} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-white">
        Sign out safely
      </button>
    </section>
  </main>
);

interface OwnerContext {
  business: { id: string; name: string; onboarding_status: string; owner_id: string };
  branches: Branch[];
  staff: StaffMember[];
}

/**
 * The web entry point is intentionally an owner-only, read-only cloud shell.
 * It does not mount the legacy operational workspaces, restore browser-held
 * role state, or call a mutation path. Those workflows re-enter only after
 * the native Hub exposes an authenticated staff-session and command bridge.
 */
function MainOSApp() {
  const [businessAuth, setBusinessAuth] = useState<BusinessAuthSession | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [showNativeCashierStation, setShowNativeCashierStation] = useState(false);
  const [, setHubHealth] = useState<NetworkHealth | null>(null);
  const [ownerAccessError, setOwnerAccessError] = useState<string | null>(null);

  const clearBrowserContext = useCallback(() => {
    setBusinessAuth(null);
    setBranches([]);
    setStaffList([]);
    setShowSetupWizard(false);
    setShowNativeCashierStation(false);
    setOwnerAccessError(null);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.warn('[OWNER_LOGOUT] Supabase sign-out warning:', error);
    } finally {
      clearBrowserContext();
    }
  }, [clearBrowserContext]);

  const loadOwnerContext = useCallback(async (candidate: BusinessAuthSession): Promise<OwnerContext> => {
    if (!candidate.isOwner || !candidate.ownerId || !candidate.businessId) {
      throw new Error('An owner-authenticated business context is required.');
    }

    const [businessResult, branchesResult, staffResult] = await Promise.all([
      supabase
        .from('businesses')
        .select('id, name, onboarding_status, owner_id')
        .eq('id', candidate.businessId)
        .maybeSingle(),
      supabase
        .from('branches')
        .select('id, name, location, is_active')
        .eq('business_id', candidate.businessId)
        .order('created_at', { ascending: true }),
      // Never select R001's legacy pin_hash into a browser response.
      supabase
        .from('staff_members')
        .select('id, name, role, branch_id, active_shift, performance_score')
        .eq('business_id', candidate.businessId),
    ]);

    if (businessResult.error) throw new Error(`Could not read the business foundation: ${businessResult.error.message}`);
    if (!businessResult.data || businessResult.data.owner_id !== candidate.ownerId) {
      throw new Error('The authenticated account is not the owner of this business.');
    }
    if (branchesResult.error) throw new Error(`Could not read branches: ${branchesResult.error.message}`);
    if (staffResult.error) throw new Error(`Could not read the staff directory: ${staffResult.error.message}`);

    const resolvedBranches = (branchesResult.data || []).map(mapBranchRowToBranch);
    if (resolvedBranches.length === 0) throw new Error('This business has no branch. Resolve the R001 foundation before enabling a station.');

    return {
      business: businessResult.data,
      branches: resolvedBranches,
      staff: (staffResult.data || []).map(mapStaffRowToStaffMember),
    };
  }, []);

  const acceptOwnerSession = useCallback(async (candidate: BusinessAuthSession) => {
    try {
      setOwnerAccessError(null);
      const context = await loadOwnerContext(candidate);
      const activeBranch = context.branches.find((branch) => branch.id === candidate.branchId) || context.branches[0];
      const resolvedAuth: BusinessAuthSession = {
        businessId: context.business.id,
        businessName: context.business.name,
        branchId: activeBranch.id,
        branchName: activeBranch.name,
        ownerId: candidate.ownerId,
        isOwner: true,
      };

      setBusinessAuth(resolvedAuth);
      setBranches(context.branches);
      setStaffList(context.staff);
      setShowSetupWizard(context.business.onboarding_status !== 'COMPLETED');
    } catch (error) {
      clearBrowserContext();
      setOwnerAccessError(error instanceof Error ? error.message : 'The owner business context could not be verified.');
    }
  }, [clearBrowserContext, loadOwnerContext]);

  const restoreOwnerSession = useCallback(async (ownerId: string) => {
    const { data: membership, error: membershipError } = await supabase
      .from('business_memberships')
      .select('business_id, role, businesses(id, name)')
      .eq('user_id', ownerId)
      .eq('role', 'OWNER')
      .maybeSingle();

    if (membershipError) throw new Error(`Could not verify business membership: ${membershipError.message}`);

    let businessId = membership?.business_id || '';
    let businessName = (membership?.businesses as { name?: string } | null)?.name || '';
    if (!businessId) {
      const { data: ownedBusiness, error: ownedBusinessError } = await supabase
        .from('businesses')
        .select('id, name')
        .eq('owner_id', ownerId)
        .maybeSingle();
      if (ownedBusinessError) throw new Error(`Could not verify owner record: ${ownedBusinessError.message}`);
      businessId = ownedBusiness?.id || '';
      businessName = ownedBusiness?.name || '';
    }

    if (!businessId) {
      throw new Error('This authenticated account has no owner business. Staff and manager access must use the enrolled Android Cashier Hub.');
    }

    const { data: branch, error: branchError } = await supabase
      .from('branches')
      .select('id, name')
      .eq('business_id', businessId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (branchError) throw new Error(`Could not verify the initial branch: ${branchError.message}`);
    if (!branch) throw new Error('This owner business has no branch. Resolve the R001 foundation before enabling a station.');

    await acceptOwnerSession({
      businessId,
      businessName: businessName || 'Business',
      branchId: branch.id,
      branchName: branch.name,
      ownerId,
      isOwner: true,
    });
  }, [acceptOwnerSession]);

  useEffect(() => {
    let mounted = true;
    let unsubscribeHub: (() => void) | undefined;

    const boot = async () => {
      try {
        // The browser shell must not boot the retired browser event, sync, or
        // certificate kernels. Its only operational capability is a measured
        // view of the native Hub bridge.
        await localHubRuntime.boot();
        if (!mounted) return;
        setHubHealth(localHubRuntime.getNetworkHealth());
        unsubscribeHub = localHubRuntime.subscribe((snapshot: { networkHealth: NetworkHealth }) => {
          if (mounted) setHubHealth(snapshot.networkHealth);
        });
      } catch (error) {
        // A browser native-bridge failure is an unavailable station, not a
        // reason to fall back to the retired operational browser paths.
        console.warn('[NATIVE_HUB_BOOT] Native Hub status is unavailable:', error);
      }
    };

    void boot();
    return () => {
      mounted = false;
      unsubscribeHub?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const restore = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user || disposed) return;
      try {
        await restoreOwnerSession(session.user.id);
      } catch (error) {
        if (!disposed) setOwnerAccessError(error instanceof Error ? error.message : 'Owner session restoration failed.');
      }
    };

    void restore();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) clearBrowserContext();
    });
    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, [clearBrowserContext, restoreOwnerSession]);

  if (ownerAccessError) return <OwnerAccessProblem message={ownerAccessError} onSignOut={() => void signOut()} />;

  if (!businessAuth) return <WelcomeScreen onLoginSuccess={(session) => void acceptOwnerSession(session)} />;

  if (showSetupWizard) {
    return (
      <Suspense fallback={<OperatingSurfaceLoading />}>
        <FirstTimeSetupWizard
          businessAuth={{
            businessId: businessAuth.businessId,
            businessName: businessAuth.businessName,
            branchId: businessAuth.branchId || '',
            branchName: businessAuth.branchName || 'Branch not configured',
            isOwner: true,
            ownerId: businessAuth.ownerId,
          }}
          onSignOut={() => void signOut()}
        />
      </Suspense>
    );
  }

  if (showNativeCashierStation) {
    return (
      <Suspense fallback={<OperatingSurfaceLoading />}>
        <NativeCashierStation
          onExit={() => setShowNativeCashierStation(false)}
          onSignOut={() => void signOut()}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<OperatingSurfaceLoading />}>
      <RoleLoginModal
        staffList={staffList}
        branches={branches}
        businessId={businessAuth.businessId}
        branchId={businessAuth.branchId}
        onOpenNativeStation={() => setShowNativeCashierStation(true)}
        onSignOut={() => void signOut()}
      />
    </Suspense>
  );
}

export default function App() {
  return <MainOSApp />;
}
