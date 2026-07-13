# Pull Request Mutations

This guide defines the remote-write boundary for comments, reviews, readiness,
close, and merge. GitHub remains the system of record. Reading a pull request or
creating a Review task does not enter this boundary.

## Confirmation contract

Every mutation shows the repository, pull request number, and exact effect. The
web app sends a snapshot of the state the user confirmed. The server rereads the
viewer and pull request immediately before writing.

The fresh preflight checks permission, lifecycle state, draft or ready state,
and head OID. Merge also passes the head OID to GitHub as an atomic guard. A
changed state returns a typed conflict instead of applying the stale intent.

## Idempotency

The web app generates one UUID for each confirmed attempt. A retry of an
outcome-unknown attempt reuses that UUID. New intent receives a new UUID.

The server registry includes viewer, pull request, effect, UUID, and a payload
fingerprint. Matching concurrent calls share one in-flight result. Successful
and outcome-unknown entries remain for ten minutes. The registry holds at most
512 entries. A definite no-effect error removes its entry, while UUID reuse with
another payload returns `idempotency_key_reused`.

## Review submission

Review submission is a three-step provider transaction:

1. Create one pending review at the confirmed head.
2. Add the bounded inline comments and replies.
3. Submit comment, approve, or request changes.

A review contains at most 100 drafts. Each prose field is at most 64 KiB, and
the review body plus all drafts is at most 1 MiB. A definite failure before
submission removes the pending provider review when GitHub confirms cleanup.
An unknown provider outcome remains `outcome_unknown`.

Local review drafts are session state. Failures preserve them. Success returns
the accepted local IDs, and the web store removes only those IDs.

## Result handling

Typed conflicts distinguish changed state, changed head, changed readiness,
lost permission, merge blocking, reused idempotency keys, outdated drafts, and
unknown outcomes. Rate limits retain the user's draft and expose retry timing.

A successful mutation invalidates pull request inbox pages, core detail,
Timeline, checks, comments, files, and patches. The next read comes from fresh
remote state rather than an optimistic reconstruction.

## Verification floor

Use fake adapters for successful writes, stale snapshots, permission loss,
conflicts, idempotent replay, key reuse, rate limits, pending-review cleanup,
and unknown outcomes. Live Mcode verification stops before every remote write.
