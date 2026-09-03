# Thread lifecycle

## Sub-features

- A first message creates a direct thread and starts one turn.
- A running turn publishes `turnStarted` and later a terminal lifecycle event.
- Two concurrent stop requests share one stop path.
- A stopped thread clears the active session count, while `agent.listRunning` retains its cancelled snapshot for reconnect hydration.

## How to get to it (user POV)

1. Open the registered project for this worktree.
2. Start a thread with the selected provider and model.
3. Stop the running thread from the chat controls.
4. Confirm that the running indicator clears.

## Driving it with verify-mcode

Run `runtime health`, then run:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider codex --model <id> --scenario stop --confirm-provider-call
```

The harness waits for `turnStarted`. It sends two `agent.stop` RPCs together. It requires matching cancelled results with one turn execution and dispatch state. It then checks a stopped event. It requires `agent.activeCount` to reach zero. It requires `agent.listRunning` to retain the matching cancelled snapshot for reconnect hydration.

## Gotchas

- The stop prompt is read-only, but a provider can finish before the stop reaches it. Treat that run as failed stop evidence.
- The harness deletes only its direct thread unless `--keep-thread` is present.
- Event capture requests journal replay with cursor 0 after creation. It does not prove a pre-create subscription.
