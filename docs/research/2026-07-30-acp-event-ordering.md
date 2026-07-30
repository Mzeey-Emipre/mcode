# ACP event ordering and Cursor mapping

Research date: 2026-07-30
Scope: ACP `session/update` delivery, prompt completion, and Mcode's Cursor mapper.

## Findings

ACP defines `session/update` as a notification carrying a `SessionUpdate` union. The union gives semantic meanings to `agent_message_chunk` (streamed response text), `tool_call` (a newly initiated call), and `tool_call_update` (status or result), but does not specify a required ordering among those variants. The schema describes them as real-time progress updates, not a turn grammar. [SessionUpdate schema](https://docs.rs/agent-client-protocol-schema/latest/agent_client_protocol_schema/v1/enum.SessionUpdate.html)

The official Rust SDK processes incoming messages through a dispatch loop. A handler blocks that loop until it returns, so messages are handled serially in receive order. Its active-session queue preserves the order in which notifications arrive. This is an SDK/transport delivery property, not a protocol promise that an agent must emit `tool_call` before text, or `tool_call_update` before later text. [Builder dispatch ordering](https://docs.rs/agent-client-protocol/latest/agent_client_protocol/struct.Builder.html), [session queue and ordering handoff](https://docs.rs/agent-client-protocol/latest/src/agent_client_protocol/session.rs.html#637-652)

Prompt completion is represented by the `session/prompt` response's `stopReason`. The SDK places that stop reason into the session queue after the response callback runs, and `read_to_string` consumes queued updates until it observes that stop reason. Therefore completion is a separate terminal signal; clients must not infer it from the last `agent_message_chunk`, `tool_call_update`, or from text arriving after a tool. [SDK prompt and stop-reason queue](https://docs.rs/agent-client-protocol/latest/src/agent_client_protocol/session.rs.html#563-617)

Late updates are explicitly possible during cancellation: the official schema docs say clients SHOULD continue accepting tool-call updates after sending `session/cancel`, because final updates may arrive before the cancelled prompt's response. [AgentNotification documentation](https://docs.rs/agent-client-protocol-schema/latest/agent_client_protocol/enum.AgentNotification.html)

Session identity is part of every `session/update`. The SDK's dynamic session handler routes messages by session id; before a handler is installed, early notifications can be queued and retried. This supports rejecting or ignoring updates for sessions that are not active, rather than attaching them to the current turn. [Dynamic handler retry rationale](https://docs.rs/agent-client-protocol/latest/agent_client_protocol/trait.HandleDispatchFrom.html)

The protocol has no duplicate-delivery or idempotency guarantee for updates. `toolCallId` is the correlation key in `tool_call` and `tool_call_update`; consumers should treat repeated terminal updates, unknown ids, and updates after local cleanup as benign stale input. This is an implementation recommendation based on the schema's correlation model, not a claim that agents are permitted to duplicate messages.

## Comparison with Mcode's current assumptions

Mcode's mapper opens a pending tool when it emits `ToolUse` for `tool_call`, resolves it on `tool_call_update`, and marks subsequent text as final once no tool calls remain. The fixture shows Cursor's common trace: `tool_call` (`pending`), optional `tool_call_update` (`in_progress`), terminal `tool_call_update` (`completed`), then the next tool or text. That trace is compatible with ACP, but ACP does not guarantee this exact sequence or that all agents provide an initial call with input. Empty-input lifecycle markers and terminal updates without a prior marker must remain valid inputs.

## Recommended focused traces

Test the mapper with ordered traces and assert event cardinality and state cleanup:

1. `tool_call` (empty input) -> `tool_call_update` (`in_progress`) -> `tool_call_update` (`completed`, output) -> text chunks -> `session/prompt` stop response: one `ToolUse`, one `ToolResult`, final text only after the result.
2. `tool_call` -> text chunk before completion -> terminal `tool_call_update`: text is ordinary streaming text, not final solely because a tool was seen.
3. Terminal `tool_call_update` without a prior `tool_call`: synthesize one tool card from update data, then one result.
4. Duplicate terminal update and unknown `toolCallId`: no duplicate Mcode result and no pending-state leak.
5. Update with a different `sessionId`, and updates arriving after `session/cancel`: ignore unrelated state; accept late terminal updates for the active session.
6. Interleaved calls (`A` pending, `B` pending, `A` complete, text, `B` complete): correlate by id, not global ordering.

These traces test the guarantees ACP actually provides: ordered receipt on one connection, explicit session identity, per-call correlation, and a separate prompt stop signal.

## Official implementation sources

The ACP organization identifies `agent-client-protocol` as the official protocol/schema repository and lists first-party Rust, TypeScript, Python, Kotlin, and Java SDKs. The Rust SDK's `SessionUpdate`, dynamic-handler, and active-session implementations are the most direct reference for ordering and late-update behavior. [Official repository](https://github.com/agentclientprotocol/agent-client-protocol), [ACP SDK index](https://agentclientprotocol.github.io/rust-sdk/)
