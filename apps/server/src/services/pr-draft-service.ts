/**
 * PR draft generation service.
 * Uses the user's configured AI provider to generate pull request titles and bodies from commit
 * history, diff stats, and conversation context.
 */

import { injectable, inject } from "tsyringe";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { logger } from "@mcode/shared";
import type { GitService } from "./git-service.js";
import type { MessageRepo } from "../repositories/message-repo.js";
import type { WorkspaceRepo } from "../repositories/workspace-repo.js";
import { SettingsService } from "./settings-service.js";
import type { IProviderRegistry, ProviderId, PrDraft } from "@mcode/contracts";

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

/** Generates AI-powered PR titles and bodies from commit history and conversation context. */
@injectable()
export class PrDraftService {
  constructor(
    @inject("GitService") private readonly gitService: GitService,
    @inject("MessageRepo") private readonly messageRepo: MessageRepo,
    @inject("WorkspaceRepo") private readonly workspaceRepo: WorkspaceRepo,
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject("IProviderRegistry") private readonly providerRegistry: IProviderRegistry,
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
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

    const repoPath = workspace.path;
    const headBranch = this.gitService.getCurrentBranch(workspaceId);

    const [commits, diffStat, messagesResult, settings] = await Promise.all([
      this.gitService.log(workspaceId, headBranch, 50, baseBranch).catch(
        (err: unknown) => {
          logger.warn("git log with base branch failed, retrying without range", {
            baseBranch,
            headBranch,
            error: err instanceof Error ? err.message : String(err),
          });
          return this.gitService.log(workspaceId, headBranch, 50);
        },
      ),
      this.gitService.diffStat(repoPath, baseBranch, headBranch).catch(
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
      this.settingsService.get(),
    ]);

    const provider = settings.model.defaults.provider;
    const model = this.resolveModel(settings.prDraft.model, provider);

    const repoTemplate = this.detectPrTemplate(repoPath);
    const conversationSummary = this.buildConversationSummary(
      messagesResult.messages,
    );
    const commitLog = commits
      .map((c: { message: string }) => `- ${c.message}`)
      .join("\n");

    const aiContext = { commitLog, diffStat, conversationSummary, repoTemplate, headBranch, baseBranch, repoPath };

    try {
      return await this.generateWithAI({ ...aiContext, provider, model });
    } catch (error) {
      // If the configured provider's CLI is unavailable, retry with Claude before giving up.
      // Claude is always required by the app, so it's a safe fallback.
      if (provider !== "claude") {
        const claudeModel = this.resolveModel(settings.prDraft.model, "claude");
        logger.warn("Configured provider unavailable for PR draft, retrying with Claude", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          return await this.generateWithAI({ ...aiContext, provider: "claude", model: claudeModel });
        } catch (claudeError) {
          logger.warn("Claude fallback also failed, using commit-only draft", {
            error: claudeError instanceof Error ? claudeError.message : String(claudeError),
          });
        }
      } else {
        logger.warn("AI PR draft generation failed, using commit-only fallback", {
          provider,
          model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return this.buildFallbackDraft(commits, diffStat);
    }
  }

  /**
   * Resolve the model to use for PR draft generation.
   * Falls back to a provider-appropriate mini model when the user has not configured one.
   */
  private resolveModel(configured: string, provider: ProviderId): string {
    if (configured) return configured;
    const defaults: Record<string, string> = {
      claude: "claude-haiku-4-5-20251001",
      codex: "o4-mini",
    };
    return defaults[provider] ?? "claude-haiku-4-5-20251001";
  }

  /** Call the configured provider to produce a structured PR title and body. */
  private async generateWithAI(context: {
    commitLog: string;
    diffStat: string;
    conversationSummary: string;
    repoTemplate: string | null;
    headBranch: string;
    baseBranch: string;
    repoPath: string;
    provider: ProviderId;
    model: string;
  }): Promise<PrDraft> {
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

    const agentProvider = this.providerRegistry.resolve(context.provider);
    const text = await agentProvider.complete(prompt, context.model, context.repoPath);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI response contained no valid JSON");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      throw new Error("Failed to parse AI response JSON");
    }

    if (typeof parsed.title !== "string" || typeof parsed.body !== "string") {
      throw new Error("AI response JSON missing required fields: title (string), body (string)");
    }

    return { title: parsed.title, body: parsed.body };
  }

  /** Scan common template paths and return the first one found, or null. */
  private detectPrTemplate(repoPath: string): string | null {
    for (const templatePath of PR_TEMPLATE_PATHS) {
      const fullPath = join(repoPath, templatePath);
      if (existsSync(fullPath)) {
        return readFileSync(fullPath, "utf-8");
      }
    }
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
