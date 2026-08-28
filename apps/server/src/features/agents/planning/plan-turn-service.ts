import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type {
  AgentEvent,
  ContextWindowMode,
  IProviderRegistry,
  PermissionMode,
  PlanOutput,
  ProviderId,
  ReasoningLevel,
} from "@mcode/contracts";
import { broadcast } from "../../../application/transport/push.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import {
  AGENT_TURN_COMMAND_PORT,
  type AgentTurnCommandPort,
} from "../orchestration/agent-turn-command-port.js";
import { PlanOutputParser } from "./plan-output-parser.js";
import { PlanQuestionParser } from "./plan-question-parser.js";
import { PlanQuestionService, type PlanAnswerInput } from "./plan-question-service.js";
import { PlanRepo } from "./persistence/plan-repo.js";

type PlanMessage = Extract<AgentEvent, { type: "message" }>;

type ClaudePlanAnswerModeProvider = {
  setPlanAnswerMode(threadId: string, enabled: boolean): void;
};

/** Owns plan-question turns and durable plan-output materialization. */
@injectable()
export class PlanTurnService {
  private readonly questionParsers = new Map<string, PlanQuestionParser>();
  private readonly outputParsers = new Map<string, PlanOutputParser>();
  private readonly pendingOutputs = new Map<string, PlanOutput>();
  private readonly pendingExitMarkdown = new Map<string, string>();
  private readonly capturedThreads = new Set<string>();

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject("IProviderRegistry") private readonly providerRegistry: IProviderRegistry,
    @inject(PlanQuestionService) private readonly questions: PlanQuestionService,
    @inject(PlanRepo) private readonly planRepo: PlanRepo,
    @inject(AGENT_TURN_COMMAND_PORT) private readonly commands: AgentTurnCommandPort,
  ) {}

  /** Start parsing one plan-question generation turn. */
  beginQuestionGeneration(threadId: string): void {
    this.questionParsers.set(threadId, new PlanQuestionParser());
  }

  /** Start parsing one structured plan-output turn and arm its native provider mode. */
  beginOutputGeneration(threadId: string): void {
    this.outputParsers.set(threadId, new PlanOutputParser());
    this.capturedThreads.delete(threadId);
    this.armNativeOutputMode(threadId);
  }

  /** Return the provider prompt used to collect plan questions. */
  buildQuestionPrompt(userMessage: string): string {
    return `[PLAN MODE] You are in planning mode. Your only job right now is to identify 2-5 key architectural decisions that need user input, based solely on the user's message below.

Constraints:
- Do NOT call any tools. Do NOT read files, run commands, or explore the codebase.
- Do NOT use native ask-question or create-plan tools; Mcode renders questions from a fenced block.
- Do NOT write any prose, preamble, or commentary.
- Your entire response MUST be the single fenced plan-questions block shown below, then stop.
- After the user answers, you will receive their selections in a follow-up turn and may then plan freely.

Output format (must be valid JSON inside the fence):

\`\`\`plan-questions
[
  {
    "id": "q1",
    "category": "CATEGORY_NAME",
    "question": "Your question here?",
    "options": [
      { "id": "o1", "title": "Option Title", "description": "Brief description.", "recommended": true },
      { "id": "o2", "title": "Another Option", "description": "Brief description." }
    ]
  }
]
\`\`\`

---

${userMessage}`;
  }

  /** Return instructions that require a structured plan-output block. */
  buildPlanOutputInstructions(): string {
    return this.questions.buildPlanOutputInstructions();
  }

  /** Consume one visible text delta while a plan turn is active. */
  onTextDelta(threadId: string, delta: string): void {
    const questions = this.questionParsers.get(threadId)?.feed(delta);
    if (questions) {
      this.questionParsers.delete(threadId);
      broadcast("plan.questions", { threadId, questions });
    }
    const output = this.outputParsers.get(threadId)?.feed(delta);
    if (output) {
      this.outputParsers.delete(threadId);
      this.pendingOutputs.set(threadId, output);
    }
  }

  /** Capture native plan markdown until its assistant message receives a durable identity. */
  handleExitPlanMode(threadId: string, planMarkdown: string): void {
    if (this.capturedThreads.has(threadId)) return;
    this.outputParsers.delete(threadId);
    this.pendingOutputs.delete(threadId);
    this.pendingExitMarkdown.set(threadId, planMarkdown);
  }

  /** Return whether a message needs early durable materialization for a plan record. */
  needsAssistantMaterialization(event: PlanMessage): boolean {
    if (!event.messageId) return false;
    return this.pendingOutputs.has(event.threadId)
      || this.pendingExitMarkdown.has(event.threadId)
      || this.outputParsers.has(event.threadId);
  }

  /** Persist the one plan record that an assistant message can materialize. */
  persistAssistantMessage(event: PlanMessage): void {
    if (!event.messageId) return;
    const output = this.pendingOutputs.get(event.threadId);
    if (output) {
      this.pendingOutputs.delete(event.threadId);
      this.outputParsers.delete(event.threadId);
      this.pendingExitMarkdown.delete(event.threadId);
      const content = output.sections.map((section) => (
        `${"#".repeat(section.level + 1)} ${section.title}\n\n${section.content}`
      )).join("\n\n");
      const sections = JSON.stringify(output.sections.map((section) => ({
        id: section.id,
        title: section.title,
        level: section.level,
      })));
      this.persistPlan(event.threadId, event.messageId, output.title, content, sections, output.changeSummary ?? null);
      return;
    }
    const markdown = this.pendingExitMarkdown.get(event.threadId);
    if (markdown) {
      this.pendingExitMarkdown.delete(event.threadId);
      this.outputParsers.delete(event.threadId);
      const extracted = this.extractMarkdown(markdown);
      if (extracted) this.persistPlan(event.threadId, event.messageId, extracted.title, extracted.contentMd, extracted.sectionsJson, null);
      return;
    }
    if (!this.outputParsers.has(event.threadId) || !event.content) return;
    this.outputParsers.delete(event.threadId);
    const extracted = this.extractMarkdown(event.content);
    if (extracted) this.persistPlan(event.threadId, event.messageId, extracted.title, extracted.contentMd, extracted.sectionsJson, null);
  }

  /** Submit answers and dispatch the complete answer turn through the command facade. */
  async answerQuestions(
    threadId: string,
    answers: PlanAnswerInput[],
    permissionMode: PermissionMode | "default" = "default",
    reasoningLevel?: ReasoningLevel,
    contextWindow?: ContextWindowMode,
    thinking?: boolean,
  ): Promise<void> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const payload = this.questions.buildAnswerPayload(threadId, answers);
    this.beginOutputGeneration(threadId);
    await this.commands.sendMessage({
      threadId,
      content: payload.content,
      permissionMode,
      model: thread.model ?? "claude-sonnet-4-6",
      attachments: [],
      reasoningLevel,
      provider: (thread.provider as ProviderId) ?? "claude",
      contextWindow,
      thinking,
      markPlanAnswerForMessageId: payload.markPlanAnswerForMessageId,
    });
  }

  /** Settle the latest plan-question batch without sending a provider turn. */
  dismissQuestions(threadId: string): void {
    const assistantMessageId = this.questions.dismiss(threadId);
    if (assistantMessageId) broadcast("plan.dismissed", { threadId, assistantMessageId });
  }

  /** Clear volatile plan state once a turn reaches its terminal lifecycle. */
  clearTurn(threadId: string): void {
    this.questionParsers.delete(threadId);
    this.outputParsers.delete(threadId);
    this.pendingOutputs.delete(threadId);
    this.pendingExitMarkdown.delete(threadId);
    this.capturedThreads.delete(threadId);
  }

  private armNativeOutputMode(threadId: string): void {
    const providerId = this.threadRepo.findById(threadId)?.provider as ProviderId | undefined;
    if (providerId !== "claude") return;
    const provider = this.providerRegistry.resolve(providerId) as Partial<ClaudePlanAnswerModeProvider>;
    provider.setPlanAnswerMode?.(threadId, true);
  }

  private persistPlan(
    threadId: string,
    messageId: string,
    title: string,
    contentMd: string,
    sectionsJson: string,
    changeSummary: string | null,
  ): void {
    if (this.capturedThreads.has(threadId)) return;
    try {
      const plan = this.planRepo.create(threadId, messageId, title, contentMd, sectionsJson, changeSummary);
      this.capturedThreads.add(threadId);
      broadcast("plan.generated", { threadId, plan });
    } catch (error) {
      logger.error("Failed to persist plan output", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private extractMarkdown(content: string): { title: string; contentMd: string; sectionsJson: string } | null {
    let title: string | null = null;
    let nextId = 0;
    const sections: Array<{ id: string; title: string; level: number }> = [];
    for (const line of content.split("\n")) {
      const match = /^(#{1,3})\s+(.+)/.exec(line);
      if (!match) continue;
      const level = match[1].length;
      const heading = match[2].trim();
      if (!title) {
        title = heading;
        continue;
      }
      nextId += 1;
      sections.push({ id: `s${nextId}`, title: heading, level });
    }
    return title && sections.length > 0
      ? { title, contentMd: content, sectionsJson: JSON.stringify(sections) }
      : null;
  }
}
