import { injectable, inject } from "tsyringe";
import { UtilityCompletionService } from "../../../shared/completion/utility-completion-service.js";
import {
  buildThreadRecapPrompt,
  sanitizeThreadRecap,
  THREAD_RECAP_MAX_MATERIAL_CHARS,
  threadRecapMaterialLength,
  type ThreadRecapMessage,
} from "./thread-recap-prompt.js";

/** Request shape for stateless recap generation. */
export interface GenerateRecapRequest {
  threadId: string;
  messages: ThreadRecapMessage[];
  previousRecap: string | null;
}

/** Stateless recap generation result. */
export interface GenerateRecapResult {
  text: string;
}

/**
 * Generates short thread recaps from caller-supplied conversation material.
 */
@injectable()
export class RecapService {
  constructor(
    @inject(UtilityCompletionService)
    private readonly utilityCompletion: UtilityCompletionService,
  ) {}

  /**
   * Generate a sanitized one-line recap without reading or storing thread state.
   */
  async generate(request: GenerateRecapRequest): Promise<GenerateRecapResult> {
    const materialLength = threadRecapMaterialLength(
      request.messages,
      request.previousRecap,
    );
    if (materialLength > THREAD_RECAP_MAX_MATERIAL_CHARS) {
      throw new Error("Recap prompt material exceeds maximum length");
    }

    const prompt = buildThreadRecapPrompt(request.messages, request.previousRecap);
    const { text } = await this.utilityCompletion.complete(prompt, process.cwd(), {
      reasoningLevel: "low",
    });

    return { text: sanitizeThreadRecap(text) };
  }
}
