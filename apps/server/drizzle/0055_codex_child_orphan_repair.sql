DROP TABLE IF EXISTS codex_child_orphan_repair_ids;--> statement-breakpoint
CREATE TEMP TABLE codex_child_orphan_repair_ids (
  id TEXT PRIMARY KEY NOT NULL
);--> statement-breakpoint
WITH RECURSIVE orphaned_threads(id) AS (
  SELECT thread.id
  FROM threads AS thread
  JOIN canonical_agent_threads AS canonical_thread ON canonical_thread.id = thread.id
  WHERE thread.id LIKE 'thread:codex-child:%'
    AND thread.title = 'Sub-agent'
    AND canonical_thread.provider_id = 'codex'
    AND canonical_thread.parent_thread_id IS NULL
    AND canonical_thread.root_thread_id = thread.id
    AND canonical_thread.owning_parent_thread_id IS NULL
  UNION
  SELECT child.id
  FROM threads AS child
  JOIN orphaned_threads AS parent ON child.parent_thread_id = parent.id
)
INSERT INTO codex_child_orphan_repair_ids (id)
SELECT id FROM orphaned_threads;--> statement-breakpoint
DELETE FROM canonical_collaboration_actions
WHERE source_thread_id IN (SELECT id FROM codex_child_orphan_repair_ids)
   OR target_thread_id IN (SELECT id FROM codex_child_orphan_repair_ids);--> statement-breakpoint
DELETE FROM canonical_agent_threads
WHERE id IN (SELECT id FROM codex_child_orphan_repair_ids);--> statement-breakpoint
DELETE FROM threads
WHERE id IN (SELECT id FROM codex_child_orphan_repair_ids);--> statement-breakpoint
DROP TABLE codex_child_orphan_repair_ids;
