# Codex subagent view

## Sub-features

- Codex `collabAgentToolCall` and V2 `subAgentActivity` events produce the same canonical child contract.
- The parent task is the primary sentence-style label in chat, the roster, and child detail. Provider identity remains separate metadata.
- A chat row opens the exact canonical child in the Subagents panel.
- Chat and detail use the same stable selection key for the identity color.
- The canonical roster moves the child from Active to Done with the exact terminal outcome.
- The child transcript contains the full message from the parent and the child's assistant message after restart.
- Child detail text remains selectable, but has no `Add comment` action. Run the [selected-text comments proof](selected-text-comments.md) for this shared renderer behavior.

## User workflow

1. Open this worktree in Electron.
2. Select Codex and `gpt-5.6-terra`.
3. Ask the parent to delegate one task to one subagent and return a unique final marker.
4. While it runs, open Subagents and confirm that the child is Active.
5. Select the subagent from chat. Confirm that the panel opens that child, converts an underscored parent task such as `verify_ui_child` to `Verify ui child`, and uses the same glyph color.
6. Confirm that the parent's full delegated message and the child's reply appear in the transcript.
7. Wait for completion. Confirm that the child moves to Done and shows Completed.
8. Stop and restart Electron, reopen the same parent thread, and repeat steps 5 to 7.

## Automated proof

Run `runtime health`, then:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime check
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider codex --model gpt-5.6-terra --scenario subagent --confirm-provider-call
```

`runtime check` covers the legacy and V2 protocol mappers, a fresh canonical reader after persistence, provider-neutral presentation, navigation, transcript mounting, sentence-style task labels, and the shared palette key. The live scenario uses the worktree-owned disposable fixture workspace. It requires an Active-to-Completed roster transition, the full parent message, the retained task, and the child's assistant marker through `conversation.page`. The detail view uses the same durable source. The verifier deletes the generated parent thread and its owned descendants unless `--keep-thread` is present.

Use the Electron workflow for visual proof. The runtime receipt does not contain provider text or screenshots.

## Failure rules

- Fail if either Codex event shape does not create the same canonical delegation fields.
- Fail if the child never appears Active or never reaches Completed.
- Fail if the canonical roster omits a descriptive parent task, repeats only the provider identity, or displays raw underscore separators.
- Fail if the child thread omits the child's assistant marker.
- Fail if the child thread omits the full message that the parent sent.
- Fail visual proof if chat does not open the exact child or the glyph palette differs between chat and detail.

## Coverage gaps

- Terra is the live V2 proof model. The legacy event shape is deterministic mapper coverage because current Codex decides which protocol item it emits.
- The public runtime receipt proves persisted data and state. Electron is required for click, color, and application-restart evidence.
