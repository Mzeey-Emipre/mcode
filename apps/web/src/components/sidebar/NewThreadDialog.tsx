import { useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";

export function NewThreadDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"direct" | "worktree">("direct");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState<string | null>(null);
  const createThread = useWorkspaceStore((s) => s.createThread);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);

  const handleCreate = async () => {
    if (!title.trim()) return;
    if (!branch.trim()) {
      setError("Branch name is required");
      return;
    }
    // Validate branch characters
    const invalidBranch = /[\s~^:?*[\\]|\.\./.test(branch) || branch.startsWith("-");
    if (invalidBranch) {
      setError("Branch name contains invalid characters");
      return;
    }
    setError(null);
    try {
      const thread = await createThread(title.trim(), mode, branch.trim());
      setActiveThread(thread.id);
      setOpen(false);
      setTitle("");
      setMode("direct");
      setBranch("main");
    } catch (e) {
      setError(String(e));
      // Keep dialog open so user can fix
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            aria-label="New thread"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus size={14} />
          </button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Thread</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="thread-title" className="text-sm font-medium">Title</label>
            <input
              id="thread-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="e.g., Add auth middleware"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Mode</label>
            <div className="flex gap-2">
              {(["direct", "worktree"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-md px-3 py-1.5 text-sm capitalize ${
                    mode === m
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="thread-branch" className="text-sm font-medium">Branch</label>
            <input
              id="thread-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          <button
            onClick={handleCreate}
            disabled={!title.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Create Thread
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
