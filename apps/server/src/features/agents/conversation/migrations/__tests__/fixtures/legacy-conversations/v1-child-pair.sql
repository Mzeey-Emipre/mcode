INSERT INTO workspaces (id, name, path, created_at, updated_at)
VALUES ('workspace-child-v1', 'Legacy Child V1', 'C:/legacy-child-v1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT INTO threads (
  id, workspace_id, title, branch, provider, sdk_session_id, permission_mode,
  created_at, updated_at
) VALUES (
  'thread-child-parent-v1', 'workspace-child-v1', 'Legacy parent', 'main', 'codex',
  'native-parent-v1', 'full', '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z'
), (
  'thread-child-v1', 'workspace-child-v1', 'Legacy child', 'main', 'codex',
  'native-child-v1', 'full', '2026-01-01T00:03:00.000Z', '2026-01-01T00:05:00.000Z'
);

UPDATE threads
SET parent_thread_id = 'thread-child-parent-v1'
WHERE id = 'thread-child-v1';

INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
VALUES
  ('parent-user-v1', 'thread-child-parent-v1', 'user', 'Parent question', '2026-01-01T00:01:00.000Z', 1),
  ('parent-assistant-v1', 'thread-child-parent-v1', 'assistant', 'Parent answer', '2026-01-01T00:02:00.000Z', 2),
  ('child-user-v1', 'thread-child-v1', 'user', 'Child question', '2026-01-01T00:03:00.000Z', 1),
  ('child-assistant-v1', 'thread-child-v1', 'assistant', 'Child answer', '2026-01-01T00:05:00.000Z', 2),
  ('child-user-v1-2', 'thread-child-v1', 'user', 'Child follow-up', '2026-01-01T00:06:00.000Z', 3),
  ('child-assistant-v1-2', 'thread-child-v1', 'assistant', 'Child follow-up answer', '2026-01-01T00:07:00.000Z', 4);

INSERT INTO tool_call_records (
  id, message_id, tool_name, input_summary, output_summary, status,
  started_at, completed_at, sort_order
) VALUES (
  'child-tool-v1', 'child-assistant-v1', 'Read', 'README.md', 'ok', 'completed',
  '2026-01-01T00:04:00.000Z', '2026-01-01T00:04:10.000Z', 0
);
