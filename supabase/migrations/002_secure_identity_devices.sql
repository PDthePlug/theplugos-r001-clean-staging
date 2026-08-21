-- Supabase Migration: 002_secure_identity_devices.sql
-- Description: R002 Secure Identity, Staff Credentials Isolation, Pgcrypto Blowfish Hashing & Trusted Device Enrollment (Incremental)

-- 1. Enable pgcrypto extension for bcrypt/blowfish crypt() hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Create isolated staff_credentials table
CREATE TABLE IF NOT EXISTS public.staff_credentials (
    staff_id UUID PRIMARY KEY REFERENCES public.staff_members(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    pin_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Defense-in-Depth RLS and strict privilege revocation for staff_credentials
ALTER TABLE public.staff_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_credentials FROM PUBLIC, anon, authenticated;

-- 3. Migrate existing device_pairing_codes
-- Drop the index if it exists
DROP INDEX IF EXISTS public.idx_device_pairing_codes_active_code;

-- Add pairing_code_hash and separate identity actor columns
ALTER TABLE public.device_pairing_codes
ADD COLUMN IF NOT EXISTS pairing_code_hash TEXT,
ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS created_by_staff_id UUID REFERENCES public.staff_members(id) ON DELETE SET NULL;

-- Safely migrate legacy created_by if present
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'device_pairing_codes' AND column_name = 'created_by'
    ) THEN
        -- Legacy created_by referenced auth.users(id)
        UPDATE public.device_pairing_codes 
        SET created_by_user_id = created_by 
        WHERE created_by_user_id IS NULL AND created_by IS NOT NULL;

        ALTER TABLE public.device_pairing_codes DROP COLUMN created_by;
    END IF;
END $$;

-- Revoke all waiting codes and set a dummy hash for existing test data
UPDATE public.device_pairing_codes
SET status = 'REVOKED',
    pairing_code_hash = 'legacy_revoked'
WHERE status = 'WAITING' OR pairing_code_hash IS NULL;

-- Enforce new schema
ALTER TABLE public.device_pairing_codes
ALTER COLUMN pairing_code_hash SET NOT NULL,
DROP COLUMN IF EXISTS pairing_code;

-- STRICTLY REVOKE direct client access to enrollment code hashes
REVOKE ALL ON public.device_pairing_codes FROM PUBLIC, anon, authenticated;

-- 4. Migrate existing devices table
ALTER TABLE public.devices
ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'TERMINAL';

UPDATE public.devices
SET last_seen = NOW()
WHERE last_seen IS NULL;

ALTER TABLE public.devices
ALTER COLUMN last_seen SET NOT NULL;

ALTER TABLE public.devices
ALTER COLUMN last_seen SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_devices_device_id_status ON public.devices(device_id, status);

-- 5. Create staff_security_sessions for delegated manager authority
CREATE TABLE IF NOT EXISTS public.staff_security_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES public.staff_members(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    session_token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Defense-in-Depth RLS and strict privilege revocation for staff_security_sessions
ALTER TABLE public.staff_security_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_security_sessions FROM PUBLIC, anon, authenticated;

-- 6. Database-Side Migration of Legacy R001 Test Data Credentials into staff_credentials
DO $$
DECLARE
    r RECORD;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'staff_members' AND column_name = 'pin_hash'
    ) THEN
        FOR r IN 
            SELECT id, business_id, pin_hash 
            FROM public.staff_members 
            WHERE pin_hash IS NOT NULL AND trim(pin_hash) != '' 
        LOOP
            IF r.pin_hash LIKE '$2a$%' OR r.pin_hash LIKE '$2b$%' THEN
                INSERT INTO public.staff_credentials (staff_id, business_id, pin_hash)
                VALUES (r.id, r.business_id, r.pin_hash)
                ON CONFLICT (staff_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash;
            ELSE
                INSERT INTO public.staff_credentials (staff_id, business_id, pin_hash)
                VALUES (r.id, r.business_id, crypt(trim(r.pin_hash), gen_salt('bf', 8)))
                ON CONFLICT (staff_id) DO NOTHING;
            END IF;
        END LOOP;

        UPDATE public.staff_members SET pin_hash = NULL;
    END IF;
END $$;

-- =========================================================
-- SECURE CREDENTIAL MANAGEMENT RPCs
-- =========================================================

-- Clean up older function signatures to prevent overload conflicts
DROP FUNCTION IF EXISTS public.set_staff_pin(UUID, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.set_staff_pin(UUID, UUID, UUID, TEXT, TEXT);

-- Function: set_staff_pin
CREATE OR REPLACE FUNCTION public.set_staff_pin(
    p_staff_id UUID,
    p_business_id UUID,
    p_branch_id UUID DEFAULT NULL,
    p_pin TEXT DEFAULT NULL,
    p_session_token TEXT DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
    v_clean_pin TEXT;
    v_caller_id UUID;
    v_is_authorized BOOLEAN := false;
    v_target_staff RECORD;
    v_session_rec RECORD;
BEGIN
    IF p_staff_id IS NULL OR p_business_id IS NULL OR p_pin IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Staff ID, Business ID, and PIN are required.');
    END IF;

    -- Fetch target staff member record
    SELECT id, business_id, branch_id, role 
    INTO v_target_staff
    FROM public.staff_members 
    WHERE id = p_staff_id 
      AND business_id = p_business_id 
      AND (p_branch_id IS NULL OR branch_id = p_branch_id);

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid staff, business, or branch binding.');
    END IF;

    v_clean_pin := trim(p_pin);
    IF v_clean_pin !~ '^\d{4,8}$' THEN
        RETURN jsonb_build_object('success', false, 'error', 'PIN must be between 4 and 8 numeric digits.');
    END IF;

    -- Authorization check:
    -- ACCOUNT ONBOARDING AUTHORITY vs OPERATIONAL TERMINAL AUTHORITY (R002 PATCH-F)
    -- 1. If p_session_token is provided (Operational Terminal Authority), evaluate staff security session FIRST.
    IF p_session_token IS NOT NULL AND trim(p_session_token) != '' THEN
        FOR v_session_rec IN 
            SELECT sss.*, sm.status as staff_status
            FROM public.staff_security_sessions sss
            JOIN public.staff_members sm ON sm.id = sss.staff_id
            WHERE sss.business_id = p_business_id 
              AND sss.role IN ('MANAGER', 'OWNER')
              AND sm.status = 'ACTIVE'
              AND sss.expires_at > NOW() 
              AND sss.revoked_at IS NULL
        LOOP
            IF v_session_rec.session_token_hash = crypt(p_session_token, v_session_rec.session_token_hash) THEN
                -- Manager authority safety checks:
                -- A Manager CANNOT modify OWNER credentials
                IF v_target_staff.role = 'OWNER' THEN
                    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Managers cannot modify Owner credentials.');
                END IF;

                -- A Manager CAN ONLY modify staff within their authorized branch
                IF v_session_rec.role = 'MANAGER' AND v_target_staff.branch_id != v_session_rec.branch_id THEN
                    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Managers can only set PINs for staff in their authorized branch.');
                END IF;

                v_is_authorized := true;
                v_caller_id := v_session_rec.staff_id;
                EXIT;
            END IF;
        END LOOP;

        IF NOT v_is_authorized THEN
            RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Invalid or expired session token for PIN administration.');
        END IF;
    -- 2. Account Onboarding Authority (Pre-terminal setup via authenticated Supabase Owner account or service_role)
    ELSIF auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_id = auth.uid()) THEN
        v_is_authorized := true;
        v_caller_id := auth.uid();
    ELSIF auth.role() = 'service_role' THEN
        v_is_authorized := true;
        v_caller_id := NULL;
    END IF;

    IF NOT v_is_authorized THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Caller is not permitted to set credentials for this business.');
    END IF;

    -- Upsert credential into isolated staff_credentials table with blowfish salt
    INSERT INTO public.staff_credentials (
        staff_id, business_id, pin_hash, failed_attempts, locked_until, updated_at
    ) VALUES (
        p_staff_id, p_business_id, crypt(v_clean_pin, gen_salt('bf', 8)), 0, NULL, NOW()
    ) ON CONFLICT (staff_id) DO UPDATE SET
        pin_hash = crypt(v_clean_pin, gen_salt('bf', 8)),
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = NOW();

    -- Audit event (NEVER log PIN or pin_hash)
    INSERT INTO public.audit_logs (
        event_id, business_id, branch_id, actor_id, entity_id, event_type, details
    ) VALUES (
        'evt-pin-set-' || extract(epoch from now())::text || '-' || floor(random()*1000)::text,
        p_business_id,
        v_target_staff.branch_id,
        COALESCE(v_caller_id::text, p_staff_id::text),
        p_staff_id::text,
        'STAFF_PIN_CREATED',
        jsonb_build_object('staff_id', p_staff_id, 'business_id', p_business_id)
    );

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Clean up older function signatures
DROP FUNCTION IF EXISTS public.verify_staff_pin(UUID, UUID, UUID, TEXT);

-- Function: verify_staff_pin (Strict 4-parameter requirement per R002 PATCH-D)
CREATE OR REPLACE FUNCTION public.verify_staff_pin(
    p_staff_id UUID,
    p_business_id UUID,
    p_branch_id UUID,
    p_pin TEXT
) RETURNS jsonb AS $$
DECLARE
    v_clean_pin TEXT;
    v_staff_id UUID;
    v_biz_id UUID;
    v_branch_id UUID;
    v_name TEXT;
    v_role TEXT;
    v_status TEXT;
    v_stored_hash TEXT;
    v_failed_attempts INTEGER;
    v_locked_until TIMESTAMPTZ;
    v_new_attempts INTEGER;
    v_lock_until TIMESTAMPTZ;
    v_session_token TEXT;
    v_session_hash TEXT;
    v_session_expires TIMESTAMPTZ;
BEGIN
    IF p_staff_id IS NULL OR p_business_id IS NULL OR p_branch_id IS NULL OR p_pin IS NULL THEN
        RETURN jsonb_build_object('authenticated', false, 'error', 'Staff ID, Business ID, Branch ID, and PIN are required.');
    END IF;

    v_clean_pin := trim(p_pin);

    -- Concurrency-Safe Atomicity: Lock credential record with exact staff, business, and branch binding
    SELECT s.id, s.business_id, s.branch_id, s.name, s.role, s.status,
           c.pin_hash, c.failed_attempts, c.locked_until
    INTO v_staff_id, v_biz_id, v_branch_id, v_name, v_role, v_status,
         v_stored_hash, v_failed_attempts, v_locked_until
    FROM public.staff_members s
    JOIN public.staff_credentials c ON c.staff_id = s.id
    WHERE s.id = p_staff_id
      AND s.business_id = p_business_id
      AND s.branch_id = p_branch_id
    FOR UPDATE OF c;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('authenticated', false, 'error', 'Invalid security PIN.');
    END IF;

    IF v_status != 'ACTIVE' THEN
        RETURN jsonb_build_object('authenticated', false, 'error', 'Staff account is inactive.');
    END IF;

    -- Enforce Lockout
    IF v_locked_until IS NOT NULL AND v_locked_until > NOW() THEN
        RETURN jsonb_build_object(
            'authenticated', false,
            'locked', true,
            'error', 'Terminal locked due to 5 consecutive failed attempts. Please wait 5 minutes.'
        );
    END IF;

    -- Verify PIN using pgcrypto crypt()
    IF v_stored_hash = crypt(v_clean_pin, v_stored_hash) THEN
        UPDATE public.staff_credentials
        SET failed_attempts = 0,
            locked_until = NULL,
            updated_at = NOW()
        WHERE staff_id = p_staff_id;

        INSERT INTO public.audit_logs (
            event_id, business_id, branch_id, actor_id, entity_id, event_type, details
        ) VALUES (
            'evt-login-ok-' || extract(epoch from now())::text || '-' || floor(random()*1000)::text,
            v_biz_id,
            v_branch_id,
            p_staff_id::text,
            p_staff_id::text,
            'STAFF_LOGIN_SUCCESS',
            jsonb_build_object('staff_id', p_staff_id, 'name', v_name, 'role', v_role)
        );

        -- If MANAGER or OWNER, create a short-lived security session
        IF v_role IN ('MANAGER', 'OWNER') THEN
            v_session_token := encode(gen_random_bytes(32), 'hex');
            v_session_hash := crypt(v_session_token, gen_salt('bf', 8));
            v_session_expires := NOW() + INTERVAL '12 hours';

            INSERT INTO public.staff_security_sessions (
                staff_id, business_id, branch_id, role, session_token_hash, expires_at
            ) VALUES (
                v_staff_id, v_biz_id, v_branch_id, v_role, v_session_hash, v_session_expires
            );

            RETURN jsonb_build_object(
                'authenticated', true,
                'staff', jsonb_build_object(
                    'id', v_staff_id,
                    'business_id', v_biz_id,
                    'branch_id', v_branch_id,
                    'name', v_name,
                    'role', v_role,
                    'status', v_status
                ),
                'sessionToken', v_session_token
            );
        END IF;

        RETURN jsonb_build_object(
            'authenticated', true,
            'staff', jsonb_build_object(
                'id', v_staff_id,
                'business_id', v_biz_id,
                'branch_id', v_branch_id,
                'name', v_name,
                'role', v_role,
                'status', v_status
            )
        );
    ELSE
        v_new_attempts := COALESCE(v_failed_attempts, 0) + 1;
        IF v_new_attempts >= 5 THEN
            v_lock_until := NOW() + INTERVAL '5 minutes';
        ELSE
            v_lock_until := NULL;
        END IF;

        UPDATE public.staff_credentials
        SET failed_attempts = v_new_attempts,
            locked_until = v_lock_until,
            updated_at = NOW()
        WHERE staff_id = p_staff_id;

        INSERT INTO public.audit_logs (
            event_id, business_id, branch_id, actor_id, entity_id, event_type, details
        ) VALUES (
            'evt-login-fail-' || extract(epoch from now())::text || '-' || floor(random()*1000)::text,
            v_biz_id,
            v_branch_id,
            p_staff_id::text,
            p_staff_id::text,
            CASE WHEN v_new_attempts >= 5 THEN 'STAFF_LOGIN_LOCKED' ELSE 'STAFF_LOGIN_FAILURE' END,
            jsonb_build_object('staff_id', p_staff_id, 'attempts', v_new_attempts)
        );

        IF v_new_attempts >= 5 THEN
            RETURN jsonb_build_object(
                'authenticated', false,
                'locked', true,
                'error', 'Terminal locked due to 5 consecutive failed attempts. Please wait 5 minutes.'
            );
        ELSE
            RETURN jsonb_build_object(
                'authenticated', false,
                'error', 'Invalid security PIN.'
            );
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- =========================================================
-- TRUSTED DEVICE ENROLLMENT RPCs
-- =========================================================

-- Clean up older function signatures
DROP FUNCTION IF EXISTS public.create_device_pairing_code(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.create_device_pairing_code(UUID, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.create_device_pairing_code(UUID, UUID, TEXT);

-- Function: create_device_pairing_code (RNG via gen_random_bytes and derived caller identity per R002 PATCH-D)
CREATE OR REPLACE FUNCTION public.create_device_pairing_code(
    p_business_id UUID,
    p_branch_id UUID,
    p_session_token TEXT DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
    v_caller_user_id UUID := NULL;
    v_caller_staff_id UUID := NULL;
    v_is_authorized BOOLEAN := false;
    v_raw_code TEXT;
    v_code_hash TEXT;
    v_expires_at TIMESTAMPTZ;
    v_session_rec RECORD;
    v_branch_exists BOOLEAN := false;
BEGIN
    IF p_business_id IS NULL OR p_branch_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Business ID and Branch ID are required.');
    END IF;

    -- Verify branch belongs to business
    SELECT EXISTS (
        SELECT 1 FROM public.branches 
        WHERE id = p_branch_id AND business_id = p_business_id
    ) INTO v_branch_exists;

    IF NOT v_branch_exists THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid branch or business binding.');
    END IF;

    -- OPERATIONAL TERMINAL CONTRACT (R002 PATCH-F):
    -- Terminal device pairing MUST require an active OWNER or MANAGER staff security sessionToken.
    -- Do NOT fall through to background Supabase owner auth (auth.uid()) on shared terminal calls.
    IF p_session_token IS NOT NULL AND trim(p_session_token) != '' THEN
        FOR v_session_rec IN 
            SELECT sss.*, sm.status as staff_status, sm.role as staff_role
            FROM public.staff_security_sessions sss
            JOIN public.staff_members sm ON sm.id = sss.staff_id
            WHERE sss.business_id = p_business_id 
              AND sss.branch_id = p_branch_id 
              AND sss.role IN ('MANAGER', 'OWNER')
              AND sm.status = 'ACTIVE'
              AND sss.expires_at > NOW() 
              AND sss.revoked_at IS NULL
        LOOP
            IF v_session_rec.session_token_hash = crypt(p_session_token, v_session_rec.session_token_hash) THEN
                v_is_authorized := true;
                v_caller_staff_id := v_session_rec.staff_id;
                EXIT;
            END IF;
        END LOOP;
    ELSIF auth.role() = 'service_role' THEN
        v_is_authorized := true;
    END IF;

    IF NOT v_is_authorized THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Operational terminal pairing requires an active OWNER or MANAGER session token.');
    END IF;

    UPDATE public.device_pairing_codes
    SET status = 'REVOKED'
    WHERE branch_id = p_branch_id AND status = 'WAITING';

    -- Cryptographically secure 6-digit RNG via gen_random_bytes
    v_raw_code := lpad((((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint & 2147483647) % 900000) + 100000)::text, 6, '0');
    v_code_hash := crypt(v_raw_code, gen_salt('bf', 8));
    v_expires_at := NOW() + INTERVAL '10 minutes';

    -- Identity derived strictly from authenticated caller (created_by_user_id or created_by_staff_id)
    INSERT INTO public.device_pairing_codes (
        pairing_code_hash, business_id, branch_id, created_by_user_id, created_by_staff_id, status, expires_at
    ) VALUES (
        v_code_hash, p_business_id, p_branch_id, v_caller_user_id, v_caller_staff_id, 'WAITING', v_expires_at
    );

    INSERT INTO public.audit_logs (
        event_id, business_id, branch_id, actor_id, event_type, details
    ) VALUES (
        'evt-enroll-code-' || extract(epoch from now())::text || '-' || floor(random()*1000)::text,
        p_business_id,
        p_branch_id,
        COALESCE(v_caller_user_id::text, v_caller_staff_id::text, 'service_role'),
        'DEVICE_ENROLLMENT_CREATED',
        jsonb_build_object('business_id', p_business_id, 'branch_id', p_branch_id, 'expires_at', v_expires_at)
    );

    RETURN jsonb_build_object(
        'success', true,
        'pairing_code', v_raw_code,
        'expires_at', v_expires_at
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Clean up older function signature
DROP FUNCTION IF EXISTS public.pair_device_with_code(TEXT, TEXT, TEXT, TEXT);

-- Function: pair_device_with_code
CREATE OR REPLACE FUNCTION public.pair_device_with_code(
    p_pairing_code TEXT,
    p_device_id TEXT,
    p_device_name TEXT DEFAULT 'POS Terminal',
    p_device_type TEXT DEFAULT 'TERMINAL'
) RETURNS jsonb AS $$
DECLARE
    v_clean_code TEXT;
    v_code_rec RECORD;
    v_rows_updated INTEGER;
    v_existing_dev RECORD;
BEGIN
    IF p_pairing_code IS NULL OR p_device_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enrollment code and device ID are required.');
    END IF;

    v_clean_code := trim(p_pairing_code);

    SELECT id, business_id, branch_id, pairing_code_hash, expires_at
    INTO v_code_rec
    FROM public.device_pairing_codes
    WHERE status = 'WAITING'
      AND expires_at > NOW()
      AND pairing_code_hash = crypt(v_clean_code, pairing_code_hash)
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired enrollment code. Please generate a new code.');
    END IF;

    -- Device Upsert Safety
    SELECT * INTO v_existing_dev FROM public.devices WHERE device_id = p_device_id;
    
    IF FOUND THEN
        IF v_existing_dev.business_id != v_code_rec.business_id AND v_existing_dev.status = 'ACTIVE' THEN
            -- Device belongs to a different business and is still active. Reject.
            RETURN jsonb_build_object('success', false, 'error', 'Device is already actively enrolled to another business. Please revoke it first.');
        END IF;
    END IF;

    UPDATE public.device_pairing_codes
    SET status = 'CONSUMED', used_at = NOW()
    WHERE id = v_code_rec.id AND status = 'WAITING';

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
    IF v_rows_updated = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enrollment code already used. Please generate a new code.');
    END IF;

    INSERT INTO public.devices (
        device_id, business_id, branch_id, name, type, status, last_seen, updated_at
    ) VALUES (
        p_device_id, v_code_rec.business_id, v_code_rec.branch_id, COALESCE(p_device_name, 'POS Terminal'), COALESCE(p_device_type, 'TERMINAL'), 'ACTIVE', NOW(), NOW()
    ) ON CONFLICT (device_id) DO UPDATE SET
        business_id = EXCLUDED.business_id,
        branch_id = EXCLUDED.branch_id,
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        status = 'ACTIVE',
        last_seen = NOW(),
        updated_at = NOW();

    INSERT INTO public.audit_logs (
        event_id, business_id, branch_id, device_id, event_type, details
    ) VALUES (
        'evt-device-enrolled-' || extract(epoch from now())::text || '-' || floor(random()*1000)::text,
        v_code_rec.business_id,
        v_code_rec.branch_id,
        p_device_id,
        'DEVICE_ENROLLED',
        jsonb_build_object('device_id', p_device_id, 'device_name', p_device_name, 'type', p_device_type)
    );

    RETURN jsonb_build_object(
        'success', true,
        'device_id', p_device_id,
        'business_id', v_code_rec.business_id,
        'branch_id', v_code_rec.branch_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Clean up older function signature
DROP FUNCTION IF EXISTS public.verify_device_status(TEXT);

-- Function: verify_device_status
CREATE OR REPLACE FUNCTION public.verify_device_status(
    p_device_id TEXT
) RETURNS jsonb AS $$
DECLARE
    v_dev_rec RECORD;
BEGIN
    IF p_device_id IS NULL THEN
        RETURN jsonb_build_object('active', false, 'status', 'NO_DEVICE_ID');
    END IF;

    SELECT id, device_id, status
    INTO v_dev_rec
    FROM public.devices
    WHERE device_id = p_device_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('active', false, 'status', 'NOT_FOUND');
    END IF;

    IF v_dev_rec.status != 'ACTIVE' THEN
        RETURN jsonb_build_object('active', false, 'status', v_dev_rec.status);
    END IF;

    UPDATE public.devices SET last_seen = NOW() WHERE id = v_dev_rec.id;

    -- Minimal disclosure
    RETURN jsonb_build_object(
        'active', true,
        'status', 'ACTIVE'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Clean up older function signatures
DROP FUNCTION IF EXISTS public.revoke_device(UUID, TEXT);
DROP FUNCTION IF EXISTS public.revoke_device(UUID, TEXT, TEXT);

-- Function: revoke_device
CREATE OR REPLACE FUNCTION public.revoke_device(
    p_business_id UUID,
    p_device_id TEXT,
    p_session_token TEXT DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
    v_caller_id UUID;
    v_is_authorized BOOLEAN := false;
    v_session_rec RECORD;
    v_device_rec RECORD;
BEGIN
    IF p_business_id IS NULL OR p_device_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Business ID and Device ID are required.');
    END IF;

    -- Lookup device to find branch_id
    SELECT * INTO v_device_rec FROM public.devices WHERE device_id = p_device_id AND business_id = p_business_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Device record not found.');
    END IF;

    -- OPERATIONAL TERMINAL CONTRACT (R002 PATCH-F):
    -- Operational device revocation MUST require an active OWNER or MANAGER staff security sessionToken.
    -- Do NOT fall through to background Supabase owner auth (auth.uid()) on shared terminal calls.
    IF p_session_token IS NOT NULL AND trim(p_session_token) != '' THEN
        FOR v_session_rec IN 
            SELECT sss.*, sm.status as staff_status
            FROM public.staff_security_sessions sss
            JOIN public.staff_members sm ON sm.id = sss.staff_id
            WHERE sss.business_id = p_business_id 
              AND sss.branch_id = v_device_rec.branch_id 
              AND sss.role IN ('MANAGER', 'OWNER')
              AND sm.status = 'ACTIVE'
              AND sss.expires_at > NOW() 
              AND sss.revoked_at IS NULL
        LOOP
            IF v_session_rec.session_token_hash = crypt(p_session_token, v_session_rec.session_token_hash) THEN
                v_is_authorized := true;
                v_caller_id := v_session_rec.staff_id;
                EXIT;
            END IF;
        END LOOP;
    ELSIF auth.role() = 'service_role' THEN
        v_is_authorized := true;
    END IF;

    IF NOT v_is_authorized THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Terminal operational revocation requires an active OWNER or MANAGER session token.');
    END IF;

    UPDATE public.devices
    SET status = 'REVOKED', updated_at = NOW()
    WHERE business_id = p_business_id AND device_id = p_device_id;

    INSERT INTO public.audit_logs (
        event_id, business_id, device_id, actor_id, event_type, details
    ) VALUES (
        'evt-device-revoked-' || extract(epoch from now())::text || '-' || floor(random()*1000)::text,
        p_business_id,
        p_device_id,
        v_caller_id::text,
        'DEVICE_REVOKED',
        jsonb_build_object('device_id', p_device_id, 'business_id', p_business_id)
    );

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Clean up older function signature
DROP FUNCTION IF EXISTS public.get_device_bootstrap(TEXT);

-- Function: get_device_bootstrap
-- Retrieves minimal authorized terminal configuration and catalog for an active enrolled device.
-- Excludes credentials, PIN hashes, and sensitive financial logs.
CREATE OR REPLACE FUNCTION public.get_device_bootstrap(
    p_device_id TEXT
) RETURNS jsonb AS $$
DECLARE
    v_dev_rec RECORD;
    v_biz_rec RECORD;
    v_branch_rec RECORD;
    v_staff_list jsonb;
    v_product_list jsonb;
BEGIN
    IF p_device_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Device ID is required.');
    END IF;

    -- 1. Prove device exists and status = 'ACTIVE'
    SELECT d.id, d.device_id, d.business_id, d.branch_id, d.status
    INTO v_dev_rec
    FROM public.devices d
    WHERE d.device_id = p_device_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Device not registered.', 'status', 'NOT_FOUND');
    END IF;

    IF v_dev_rec.status != 'ACTIVE' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Device status is not active.', 'status', v_dev_rec.status);
    END IF;

    -- Update last_seen timestamp
    UPDATE public.devices SET last_seen = NOW() WHERE id = v_dev_rec.id;

    -- 2. Fetch Business public identity (EXCLUDING cloud owner_id per R002 PATCH-F capability review)
    SELECT id, name, onboarding_status
    INTO v_biz_rec
    FROM public.businesses
    WHERE id = v_dev_rec.business_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Associated business not found.');
    END IF;

    -- 3. Fetch Branch
    SELECT id, name, business_id
    INTO v_branch_rec
    FROM public.branches
    WHERE id = v_dev_rec.branch_id;

    -- 4. Fetch Staff directory for branch (EXCLUDING any credential or PIN data)
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', s.id,
                'name', s.name,
                'role', s.role,
                'branch_id', s.branch_id,
                'status', s.status,
                'active_shift', COALESCE(s.active_shift, false),
                'performance_score', COALESCE(s.performance_score, 100)
            )
        ),
        '[]'::jsonb
    ) INTO v_staff_list
    FROM public.staff_members s
    WHERE s.business_id = v_dev_rec.business_id
      AND s.branch_id = v_dev_rec.branch_id
      AND s.status = 'ACTIVE';

    -- 5. Fetch Products catalog for business/branch
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', p.id,
                'name', p.name,
                'category', p.category,
                'price', p.price,
                'cost_price', p.cost_price,
                'costPrice', p.cost_price,
                'stock', p.stock_quantity,
                'description', p.description,
                'unit', p.unit_of_measure,
                'branch_id', p.branch_id
            )
        ),
        '[]'::jsonb
    ) INTO v_product_list
    FROM public.catalog_products p
    WHERE p.business_id = v_dev_rec.business_id
      AND (p.branch_id IS NULL OR p.branch_id = v_dev_rec.branch_id);

    RETURN jsonb_build_object(
        'success', true,
        'business', jsonb_build_object(
            'id', v_biz_rec.id,
            'name', v_biz_rec.name,
            'onboarding_status', v_biz_rec.onboarding_status
        ),
        'branch', jsonb_build_object(
            'id', v_branch_rec.id,
            'name', v_branch_rec.name,
            'business_id', v_branch_rec.business_id
        ),
        'staff', v_staff_list,
        'products', v_product_list
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- BLOCKER 11: EXPLICIT FUNCTION PRIVILEGES MATRIX
-- PostgreSQL functions receive PUBLIC EXECUTE by default.
-- For EVERY R002 RPC, REVOKE ALL from PUBLIC, anon, authenticated, then GRANT only intended roles.

REVOKE ALL ON FUNCTION public.set_staff_pin(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_staff_pin(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_device_pairing_code(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pair_device_with_code(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_device_status(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_device(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_device_bootstrap(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_staff_pin(UUID, UUID, UUID, TEXT, TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.verify_staff_pin(UUID, UUID, UUID, TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.create_device_pairing_code(UUID, UUID, TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.pair_device_with_code(TEXT, TEXT, TEXT, TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.verify_device_status(TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.revoke_device(UUID, TEXT, TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_device_bootstrap(TEXT) TO authenticated, anon;
