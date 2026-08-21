import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.2';
import {
  syncRequestBytes,
  utf8JsonObjectFromBase64Url,
  verifyP256DerSignature,
} from '../_shared/hub-protocol.ts';
import {
  HubConfigurationError,
  HubHttpError,
  base64url,
  canonicalUtc,
  genericFailure,
  noStoreJson,
  object,
  requireNativeJson,
  rpc,
  storageHmac,
  string,
  uuid,
  withinClockSkew,
} from '../_shared/hub-edge.ts';

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

Deno.serve(async (request) => {
  try {
    const body = await requireNativeJson(request, 512 * 1024);
    const client = serviceClient();
    const requestId = uuid(body.requestId, 'Request ID');
    const hubDeviceId = deviceId(body.hubDeviceId);
    const bundleId = uuid(body.bundleId, 'Bundle ID');
    const issuedAt = canonicalUtc(body.issuedAt, 'Sync issue time');
    withinClockSkew(issuedAt);
    const payloadBase64 = base64url(body.payloadBase64, 'Sync payload', 2, 500_000);
    const signature = base64url(body.signature, 'Sync proof', 8, 256);
    const payload = utf8JsonObjectFromBase64Url(payloadBase64, 'Sync payload');
    if (Object.keys(payload).length !== 1 || !Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 100) {
      throw new HubHttpError(400, 'Sync payload is invalid.');
    }

    const deviceHash = await storageHmac('sync-device', hubDeviceId);
    const context = object(await rpc<unknown>(client, 'r003_get_hub_sync_context', {
      p_hub_device_id: hubDeviceId,
      p_bundle_id: bundleId,
      p_device_hash: deviceHash,
    }), 'Sync context');
    // RECOVERY is replication-only: the SQL receiver additionally requires
    // every event to predate the active bundle's expiry. The endpoint never
    // uses this state to authorize a new local command.
    if (context.state !== 'ACTIVE' && context.state !== 'RECOVERY') return genericFailure();
    const key = base64url(context.hubSigningPublicKeyBase64, 'Hub signing public key', 64, 4096);
    const proof = syncRequestBytes({ requestId, hubDeviceId, bundleId, issuedAt, payloadBase64 });
    if (!await verifyP256DerSignature(key, proof, signature)) return genericFailure();

    const receipt = object(await rpc<unknown>(client, 'r003_ingest_hub_events', {
      p_hub_device_id: hubDeviceId,
      p_bundle_id: bundleId,
      p_events: payload.events,
    }), 'Sync receipt');
    return noStoreJson({ ok: true, acknowledgedEventIds: receipt.acknowledgedEventIds ?? [] });
  } catch (error) {
    if (error instanceof HubHttpError) return genericFailure(error.status === 413 ? 413 : 400);
    if (error instanceof HubConfigurationError) return genericFailure(503);
    return genericFailure();
  }
});

function deviceId(value: unknown): string {
  const result = string(value, 'Hub device ID', 200);
  if (!DEVICE_ID.test(result)) throw new HubHttpError(400, 'Hub device ID is invalid.');
  return result;
}

function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new HubConfigurationError('Supabase service configuration is missing.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
