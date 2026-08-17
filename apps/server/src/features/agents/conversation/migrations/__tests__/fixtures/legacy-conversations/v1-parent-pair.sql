INSERT INTO workspaces (id, name, path, created_at, updated_at)
VALUES ('workspace-v1', 'Legacy V1', 'C:/legacy-v1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT INTO threads (
  id, workspace_id, title, branch, provider, sdk_session_id, permission_mode,
  created_at, updated_at
) VALUES (
  'thread-v1', 'workspace-v1', 'Legacy parent', 'main', 'codex',
  'native-thread-v1', 'full', '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z'
);

INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
VALUES
  ('user-v1', 'thread-v1', 'user', 'Question', '2026-01-01T00:01:00.000Z', 1),
  ('assistant-v1', 'thread-v1', 'assistant', 'Answer', '2026-01-01T00:02:00.000Z', 2);

INSERT INTO thought_segments (
  id, message_id, text, started_at, ended_at, sort_order, is_final_response
) VALUES (
  'thought-v1', 'assistant-v1', 'Reasoned', '2026-01-01T00:01:30.000Z',
  '2026-01-01T00:01:40.000Z', 0, 0
);
