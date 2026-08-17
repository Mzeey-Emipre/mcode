INSERT INTO workspaces (id, name, path, created_at, updated_at)
VALUES ('workspace-ambiguous', 'Legacy ambiguous', 'C:/legacy-ambiguous', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT INTO threads (
  id, workspace_id, title, branch, provider, created_at, updated_at
) VALUES (
  'thread-ambiguous', 'workspace-ambiguous', 'Legacy ambiguous parent', 'main',
  'claude', '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z'
);

INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
VALUES (
  'assistant-ambiguous', 'thread-ambiguous', 'assistant', 'Unattributed answer',
  '2026-01-01T00:02:00.000Z', 1
);
