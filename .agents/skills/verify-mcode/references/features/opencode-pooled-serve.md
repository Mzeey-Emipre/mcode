# OpenCode pooled serve

## Sub-features

- Enabling OpenCode with an authenticated `opencode` CLI starts threads on the OpenCode provider.
- Two threads in one worktree share one `serve` process; a second worktree gets its own.
- A sent prompt streams a live reply to completion and the thread status returns ready.
- Stop mid-stream settles the turn as aborted with no further output while the server stays warm.
- Idle servers close after the TTL with proven process-tree termination; unexpected exits clean up without orphans.

## How to get to it (user POV)

1. Install and authenticate the `opencode` CLI (`opencode --version` succeeds, account logged in).
2. Enable OpenCode in Settings > Providers.
3. Open a thread on the OpenCode provider, send a prompt, watch the reply stream.
4. Stop a runaway turn from the chat controls and confirm it settles.

## Driving it with verify-mcode

Run `runtime health`, then run:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider opencode --model <provider/model-id> --scenario completion --confirm-provider-call
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider opencode --model <provider/model-id> --scenario stop --confirm-provider-call
```

Completion requires `turnComplete` or `ended`, then a durable assistant message in `conversation.page` and `message.list`. Stop requires the cancelled settle with `agent.activeCount` at zero. The receipt omits assistant text and provider-private payloads.

Serve-pool mechanics without a model call (spawn, health, session create, abort, idle close) are covered by the focused pool tests; use them when no provider account is logged in.

## Browser proof

Drive the real web UI (Playwright, Chromium headless):

```sh
python .agents/skills/verify-mcode/scripts/browser-opencode-proof.py --help
python .agents/skills/verify-mcode/scripts/browser-opencode-proof.py
```

It picks the fixture-repo project, opens the model picker, chooses the OpenCode section and a live
model, sends a prompt, and asserts the assistant bubble settles with the exact reply. Evidence lands in
`.dev/verification/agent-runtime/browser-opencode-proof.png`. The script enables OpenCode in the
Electron profile over the desktop socket, then deletes its thread unless `--keep-thread` is given.
Requires a running agent runtime and the Playwright scratch install
(`electorn-live-testing` ensure-playwright).

## Gotchas

- Provider discovery does not check account login. Record a live authentication error as a blocked provider, then rerun after login. Missing OpenCode auth is a coverage gap, not a pass.
- Model IDs are `provider/model` slugs from `provider.listModels` for `opencode` (for example `anthropic/claude-sonnet-4-6`), not bare model names.
- Free-tier models can interrupt a turn under load; the harness records the phase and the next turn still dispatches. Treat isolated interruptions as flakiness, repeats as a defect.
- The pool keys on binary path, working directory, and hostname. Proving isolation needs two threads in different worktrees, not two threads in one worktree.
- A desktop reload needs `$electorn-live-testing`; this harness proves the public server conversation RPC only.
