# Provider conformance fixtures

Keep raw Provider captures in `packages/providers/.conformance-raw/`. Git ignores this directory because raw captures can contain private data.

Use this procedure after a Provider-specific capture tool writes normalized JSONL rows:

1. Review the raw capture locally.
2. Create a metadata JSON file under `.conformance-raw/`.
3. Run `bun run conformance:sanitize -- .conformance-raw/<capture>.jsonl src/conformance/fixtures/<fixture>.json .conformance-raw/<metadata>.json` from `packages/providers`.
4. Review the complete committed fixture diff.
5. Run `bun run test` and `bun run typecheck`.

The sanitizer accepts only structural event fields. It removes native identifiers through stable aliases. It never copies prompts, responses, environment data, paths, or tool output.

Provider cutover tickets own their protocol-specific capture tools and captured fixtures. Synthetic fixtures must use `"provenance": "synthetic"`. Do not present synthetic input as live Provider evidence.
