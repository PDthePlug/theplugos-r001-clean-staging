# Owner browser access and recovery contract

- **Status:** Gate 0 source contract
- **Date:** 21 August 2026
- **Applies to:** public arrival, owner sign-in, owner account recovery, and
  R001 business-context selection
- **Authority:** ThePlugOS Constitution, ADR-001, and ADR-003

## Purpose

The browser remains an owner-facing cloud foundation surface. It can establish
an authenticated owner context, create an R001 business foundation, and show
the next approved native-Hub step. It is not a staff terminal and it never
becomes an operational authority.

This contract closes three R001 access gaps without inventing a replacement
backend: account recovery, confirmed-but-unbound owner accounts, and explicit
selection where one owner has more than one business.

## Browser states

| State | Permitted action | Must not do |
| --- | --- | --- |
| Unauthenticated | Sign in, start owner registration, request password recovery | Query business data or accept staff credentials |
| Confirmation pending | Explain that no business foundation was created and require a confirmed session | Persist a pending password or silently create a business later |
| Confirmed, unbound account | Create exactly one selected R001 business foundation through the existing atomic RPC | Treat an Auth account alone as a station identity |
| Multiple owner businesses | Require an explicit business choice before loading branches or staff directory data | Pick an arbitrary business or restore the last browser-held business |
| Owner context loaded | Read owner-scoped R001 foundation facts and hand off to native onboarding/station UI | Enter staff PINs, issue device credentials, or mutate operational records |
| Recovery link | Let Supabase validate the recovery session, update the password, sign out, and remove the recovery marker | Log, cache, or pass password/recovery material to the application |

## Access rules

1. The browser derives the selected business from an authenticated account's
   current R001 owner records; it never trusts a persisted business ID or a
   caller-supplied role.
2. A business must still prove that its `owner_id` is the authenticated owner
   before branches or staff directory facts are loaded.
3. A newly registered account with email confirmation enabled creates no
   business data until it later has a valid session and explicitly completes
   the R001 creation action.
4. The only browser mutation in this contract is the accepted R001
   `create_business_with_owner_and_branch` RPC. Staff, PIN, device, catalog,
   order, inventory, shift, payment, and Hub authority flows remain outside
   this browser boundary.
5. Password-reset links return through a same-origin `auth=recovery` marker.
   The marker controls presentation only; Supabase Auth decides whether the
   recovery session is valid.

## Privacy and failure rules

- Do not log email addresses, user IDs, business IDs, passwords, access
  tokens, reset links, or raw Supabase errors from browser access flows.
- Authentication failure copy is intentionally non-enumerating.
- A failed owner-context lookup leaves the browser without a business context;
  it does not fall back to a legacy workspace or browser-held staff state.
- A failed recovery request tells the user to check their inbox without
  confirming whether an account exists.
- A failed business creation leaves the account authenticated but does not
  assume a partial foundation exists; the owner may retry the atomic RPC after
  reviewing the error.

## Operational boundary

This contract does not relax ADR-003. Browser owner access cannot create a
staff session, perform a sale, announce LAN status, claim cloud delivery, or
operate a paired terminal. Those facts continue to require the enrolled
Android Cashier Hub and its signed authorization bundle.
