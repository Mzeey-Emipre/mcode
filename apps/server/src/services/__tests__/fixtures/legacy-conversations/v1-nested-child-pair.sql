INSERT INTO workspaces (id, name, path, created_at, updated_at)
VALUES ('workspace-nested-v1', 'Legacy Nested V1', 'C:/legacy-nested-v1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT INTO threads (
  id, workspace_id, title, branch, provider, sdk_session_id, permission_mode,
  created_at, updated_at
) VALUES
  ('thread-nested-parent', 'workspace-nested-v1', 'Legacy parent', 'main', 'codex',
   'native-nested-parent', 'full', '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z'),
  ('thread-z-child', 'workspace-nested-v1', 'Legacy child', 'main', 'codex',
   'native-z-child', 'full', '2026-01-01T00:03:00.000Z', '2026-01-01T00:04:00.000Z'),
  ('thread-a-grandchild', 'workspace-nested-v1', 'Legacy grandchild', 'main', 'codex',
   'native-a-grandchild', 'full', '2026-01-01T00:05:00.000Z', '2026-01-01T00:06:00.000Z');

UPDATE threads SET parent_thread_id = 'thread-nested-parent' WHERE id = 'thread-z-child';
UPDATE threads SET parent_thread_id = 'thread-z-child' WHERE id = 'thread-a-grandchild';

INSERT INTO messages (id, thread_id, role, content, timestamp, sequence)
VALUES
  ('nested-parent-user', 'thread-nested-parent', 'user', 'Parent question', '2026-01-01T00:01:00.000Z', 1),
  ('nested-parent-assistant', 'thread-nested-parent', 'assistant', 'Parent answer', '2026-01-01T00:02:00.000Z', 2),
  ('nested-child-user', 'thread-z-child', 'user', 'Child question', '2026-01-01T00:03:00.000Z', 1),
  ('nested-child-assistant', 'thread-z-child', 'assistant', 'Child answer', '2026-01-01T00:04:00.000Z', 2),
  ('nested-grandchild-user', 'thread-a-grandchild', 'user', 'Grandchild question', '2026-01-01T00:05:00.000Z', 1),
  ('nested-grandchild-assistant', 'thread-a-grandchild', 'assistant', 'Grandchild answer', '2026-01-01T00:06:00.000Z', 2);
