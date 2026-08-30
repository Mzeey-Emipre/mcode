/**
 * PR draft generation service.
 * Uses the user's configured AI provider to generate pull request titles and bodies from commit
 * history, diff stats, and conversation context.
 */

import { injectable, inject } from "tsyringe";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { logger } from "@mcode/shared";
import { GitComparisonService } from "../../projects/git/git-comparison-service.js";
import { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import type { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { PrDraft } from "@mcode/contracts";
import { UtilityCompletionService } from "../../../shared/completion/utility-completion-service.js";
import { parseCompletionDraft } from "./pr-draft-parser.js";

/** Candidate paths for a repo-level PR template, checked in order. */
const PR_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
];

/** Default PR body structure used when no repo template is found. */
const DEFAULT_FORMAT = `## What
[2-3 sentence summary of what changed]

## Why
[Motivation from conversation context - the decisions, trade-offs, and goals discussed]

## Key Changes
- [Bullet list derived from commits and diff]`;

/** Maximum PR template file size. Templates larger than this are skipped. */
const MAX_TEMPLATE_BYTES = 64 * 1024;

interface DraftContext {
  commits: Array<{ message: string }>;
  commitLog: string;
  diffStat: string;
  conversationSummary: string;
  repoTemplate: string | null;
  headBranch: string;
  baseBranch: string;
  repoPath: string;
}

function isNonRecoverableDraftError(message: string): boolean {
  return [
    "does not support",
    "no valid JSON",
    "could not be parsed",
    "failed validation",
  ].some((fragment) => message.includes(fragment));
}

/** Generates AI-powered PR titles and bodies from commit history and conversation context. */
@injectable()
export class PrDraftService {
  private readonly templateCache = new Map<string, string | null>();

  constructor(
    @inject(GitComparisonService) private readonly gitComparison: GitComparisonService,
    @inject(GitRepositoryService) private readonly gitRepository: GitRepositoryService,
    @inject(GitWorktreeService) private readonly gitWorktrees: GitWorktreeService,
    @inject("MessageRepo") private readonly messageRepo: MessageRepo,
    @inject("WorkspaceRepo") private readonly workspaceRepo: WorkspaceRepo,
    @inject("ThreadRepo") private readonly threadRepo: ThreadRepo,
    @inject(UtilityCompletionService) private readonly utilityCompletion: UtilityCompletionService,
  ) {}

  /**
   * Generate a PR title and body using commit history, diff stat, and thread conversation.
   * Falls back to a commit-only draft when AI generation fails.
   */
  async generateDraft(
    workspaceId: string,
    threadId: string,
    baseBranch: string,
  ): Promise<PrDraft> {
    const context = await this.loadDraftContext(workspaceId, threadId, baseBranch);
    if (context.commits.length === 0) {
      return this.buildFallbackDraft(context.commits, context.diffStat);
    }

    try {
      return await this.generateWithAI(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNonRecoverableDraftError(message)) {
        logger.error("PR draft generation failed with a non-recoverable error", { error: message });
        throw error;
      }
      logger.warn("AI PR draft generation failed, using commit-only fallback", { error: message });
      return this.buildFallbackDraft(context.commits, context.diffStat);
    }
  }

  private async loadDraftContext(
    workspaceId: string,
    threadId: string,
    baseBranch: string,
  ): Promise<DraftContext> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    if (thread.workspace_id !== workspaceId) {
      throw new Error(`Thread ${threadId} does not belong to workspace ${workspaceId}`);
    }

    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

    const repoPath = this.gitWorktrees.resolveWorkingDir(
      workspace.path,
      thread.mode,
      thread.worktree_path,
    );
    const headBranch = await this.gitRepository.getCurrentBranchAt(repoPath);
    if (!headBranch || headBranch === "HEAD") {
      throw new Error("Cannot generate PR draft: repository is in detached HEAD state or not a git repo");
    }

    const [commits, diffStat, messagesResult] = await Promise.all([
      this.gitComparison.listCommits(workspaceId, headBranch, 50, baseBranch, repoPath).catch(
        (err: unknown) => {
          logger.warn("git log with base branch failed, retrying without range", {
            baseBranch,
            headBranch,
            error: err instanceof Error ? err.message : String(err),
          });
          return this.gitComparison.listCommits(workspaceId, headBranch, 50, undefined, repoPath);
        },
      ),
      this.gitComparison.readBranchComparisonDiffStat(repoPath, baseBranch, headBranch).catch(
        (err: unknown) => {
          logger.warn("git diff --stat failed, skipping diff context", {
            baseBranch,
            headBranch,
            error: err instanceof Error ? err.message : String(err),
          });
          return "";
        },
      ),
      Promise.resolve(this.messageRepo.listByThread(threadId, 100)),
    ]);

    const repoTemplate = this.detectPrTemplate(repoPath);
    const conversationSummary = this.buildConversationSummary(messagesResult.messages);
    const commitLog = commits
      .map((c: { message: string }) => `- ${c.message}`)
      .join("\n");
    return {
      commits,
      diffStat,
      conversationSummary,
      repoTemplate,
      headBranch,
      baseBranch,
      repoPath,
      commitLog,
    };
  }

  /** Call the configured provider's one-shot completion and parse the structured result. */
  private async generateWithAI(context: DraftContext): Promise<PrDraft> {
    const formatInstruction = context.repoTemplate
      ? `Follow this PR template structure from the repository:\n\n${context.repoTemplate}`
      : `Use this structure:\n\n${DEFAULT_FORMAT}`;

    const prompt = [
      "Generate a pull request title and body as JSON: { \"title\": \"...\", \"body\": \"...\" }",
      "The title must be concise (under 70 chars), using conventional commit format (feat:, fix:, etc.).",
      formatInstruction,
      "End the body with:\n\n---\nGenerated by [mcode](https://github.com/mzeey-empire/mcode) from conversation and commit history",
      "",
      `Branch: ${context.headBranch} -> ${context.baseBranch}`,
      "",
      "## Commits",
      context.commitLog || "(no commits)",
      "",
      "## Diff Summary",
      context.diffStat || "(no changes)",
      "",
      "## Conversation Context",
      context.conversationSummary || "(no conversation history)",
    ].join("\n\n");

    const { text } = await this.utilityCompletion.complete(prompt, context.repoPath);
    return parseCompletionDraft(text);
  }

  /** Scan common template paths and return the first one found, or null. Results are cached per repoPath. */
  private detectPrTemplate(repoPath: string): string | null {
    if (this.templateCache.has(repoPath)) {
      return this.templateCache.get(repoPath) ?? null;
    }
    for (const templatePath of PR_TEMPLATE_PATHS) {
      const fullPath = join(repoPath, templatePath);
      if (existsSync(fullPath)) {
        try {
          const { size } = statSync(fullPath);
          if (size > MAX_TEMPLATE_BYTES) {
            logger.warn("PR template file exceeds size limit, skipped", { fullPath, size });
            continue;
          }
          const content = readFileSync(fullPath, "utf-8");
          this.templateCache.set(repoPath, content);
          return content;
        } catch {
          continue;
        }
      }
    }
    this.templateCache.set(repoPath, null);
    return null;
  }

  /** Produce a condensed conversation transcript from the most recent messages. */
  private buildConversationSummary(
    messages: Array<{ role: string; content: string }>,
  ): string {
    const relevant = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-20);

    if (relevant.length === 0) return "";

    return relevant
      .map(
        (m) =>
          `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 500)}`,
      )
      .join("\n\n");
  }

  /** Build a minimal PR draft from commit messages when AI is unavailable. */
  private buildFallbackDraft(
    commits: Array<{ message: string }>,
    diffStat: string,
  ): PrDraft {
    const title = commits[0]?.message ?? "Untitled PR";
    const commitList = commits.map((c) => `- ${c.message}`).join("\n");

    const changedFiles = diffStat
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("|"))
      .map((line) => `- ${line.split("|")[0].trim()}`)
      .slice(0, 20);
    const keyChanges = changedFiles.length > 0
      ? changedFiles.join("\n")
      : "_Fill in the key changes._";

    const body = [
      "## What",
      "",
      commitList || "No commits found.",
      "",
      "## Why",
      "",
      "_Fill in the motivation for this change._",
      "",
      "## Key Changes",
      "",
      keyChanges,
      "",
      "---",
      "Generated by [mcode](https://github.com/mzeey-empire/mcode) from commit history",
    ].join("\n");

    return { title, body };
  }
}
