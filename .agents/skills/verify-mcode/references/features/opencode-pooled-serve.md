# OpenCode pooled serve

## Sub-features
- Enabling OpenCode with an authenticated `opencode` CLI starts threads on the OpenCode provider.
- Two threads in one worktree share one `serve` process; a second worktree gets its own.
- A sent prompt streams a live reply to completion and the thread status returns ready.
- Stop mid-stream settles the turn as aborted with no further output while the server stays warm.
- Idle servers close after the TTL with proven process-tree termination; unexpected exits clean up without orphans.
- Restart resume: turns survive app restarts on the same upstream session. The durable resume cursor is re-adopted behind a versioned parser and verified with one bounded history page (limit 1); only a confirmed 404 starts fresh.
- Deleted upstream: a session deleted outside the app starts fresh with the canonical `sdk_session_invalidated` notice; other threads keep their own sessions.
- Paged history: upstream history reads always carry a bounded limit (1-200, 10s timeout, abort); heavy threads page through `conversation.page` / `message.list`. Broken history surfaces a visible error, never an endless spinner.
- Event mapping (#1624): every schema-valid upstream event classifies as mapped, state-only, diagnostic, or ignored-with-reason across wrapped and flat envelopes. Unknown valid types become one bounded provider-neutral diagnostic; oversized envelopes are rejected at the adapter boundary. Raw upstream payload never reaches ingress, persistence, transport, or UI.
- Supervised permissions (#1624): permission and question asks surface as inline cards through the existing permission flow (`permission.request` → `permission.respond` → upstream reply). A shell approval relays once. A question reply carries the user’s ordered selected labels; questions do not offer session approval. Reject relays once and the turn settles cleanly. Duplicate replies and terminal outcomes are blocked.
- Provider notices (#1624): reroute (`session.next.model.switched`) uses the canonical model-fallback event. Warning/error toasts, configuration signals, and authentication failures use bounded provider-neutral notices with replay deduplication. The screen and thread state stay intact.

## How to get to it (user POV)

1. Install and authenticate the `opencode` CLI (`opencode --version` succeeds, account logged in).
2. Enable OpenCode in Settings > Providers.
3. Open a thread on the OpenCode provider, send a prompt, watch the reply stream.
4. Stop a runaway turn from the chat controls and confirm it settles.
5. Close the app, reopen, and continue the same thread: prior context is intact with no new session created.
6. Delete the upstream session outside the app (`DELETE /session/:id`), send again: a fresh session starts with the visible provider-neutral session-reset notice, other threads unaffected.
7. Open a very large thread: the latest page renders fast, older pages lazy-load; broken history shows an error, never a spinner.
8. Supervised shell approval: on a supervised OpenCode thread, send a prompt that runs a shell command. Confirm the inline approval card (`permission.request`), approve once (`permission.respond` with `allow`), and confirm the command runs once and the turn continues to completion.
9. Supervised question: send a prompt that asks a question. Select an option or enter a custom answer, submit the ordered answers through `permission.respond`, and confirm the provider continues. Confirm no session-wide approval control appears.
10. Supervised rejection: reject either card (`deny`) and confirm the turn settles with one terminal outcome.
11. Unknown-event diagnostic (focused tests only; no public seam injects upstream events by design): the mapper tests cover unknown valid types across both envelope shapes and oversized-envelope rejection. Record live unknown-event injection as a coverage gap, not a pass.

## Driving it with verify-mcode

Run `runtime health`, then run:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider opencode --model opencode/muse-spark-1.3-contributor-free --scenario completion --confirm-provider-call
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider opencode --model opencode/muse-spark-1.3-contributor-free --scenario stop --confirm-provider-call
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider opencode --model opencode/muse-spark-1.3-contributor-free --scenario opencode-resume --confirm-provider-call
```

Completion requires `turnComplete` or `ended`, then a durable assistant message in `conversation.page` and `message.list`. Stop requires the cancelled settle with `agent.activeCount` at zero. The receipt omits assistant text and provider-private payloads.

The OpenCode resume proof creates and removes an owned temporary workspace with two owned direct threads. It restarts only this worktree runtime, continues the first thread on its original upstream session, deletes the second thread's owned upstream session through `opencode session delete`, and checks the public `sdk_session_invalidated` event plus both persisted session identities. It deletes the threads and workspace after the proof. The focused web store test covers the generic reset notice. This command does not claim browser proof for the notice.

Focused OpenCode HTTP-client tests prove the 1-200 page bound, default limit, timeout, caller abort, 404 discrimination, malformed-response failure, and cleanup. The live resume proof confirms that app restart uses the bounded resume path, but it does not inspect the upstream query string.

Serve-pool mechanics without a model call (spawn, health, session create, abort, idle close) are covered by the focused pool tests; use them when no provider account is logged in.

## Browser proof

Drive the real Electron UI through Playwright:

```sh
bun .agents/skills/verify-mcode/scripts/browser-opencode-proof.mjs --help
bun .agents/skills/verify-mcode/scripts/browser-opencode-proof.mjs --confirm-provider-call
```

It picks the fixture-repo project, opens the model picker, chooses the OpenCode section and a live
model, sends a prompt, and asserts the assistant bubble settles with the exact reply. Evidence lands in
`.dev/verification/agent-runtime/browser-opencode-proof.png`. The script enables OpenCode in the
Electron profile over the desktop socket, then deletes its thread unless `--keep-thread` is given.
Requires a running agent runtime and the Playwright scratch install
(`electorn-live-testing` ensure-playwright).

## Gotchas

- Provider discovery does not check account login. Record a live authentication error as a blocked provider, then rerun after login. Missing OpenCode auth is a coverage gap, not a pass.
- OpenCode quota was exhausted for the #1624 verification run. The primary completion, stop, resume, permission, and question proof is blocked until quota is available. Focused mapper, HTTP-client, provider, RPC, and inline-card tests support component behavior only; they do not prove the live public path.
- Model IDs are `provider/model` slugs from `provider.listModels` for `opencode` (for example `opencode/muse-spark-1.3-contributor-free`), not bare model names.
- Free-tier models can interrupt a turn under load; the harness records the phase and the next turn still dispatches. Treat isolated interruptions as flakiness, repeats as a defect.
- The pool keys on binary path, working directory, and hostname. Pool isolation needs two different worktrees; the resume journey instead checks per-thread session isolation in one owned workspace.
- A desktop reload needs `$electorn-live-testing`; this harness proves the public server conversation RPC only.
