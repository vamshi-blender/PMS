import OpenAI from "openai";
import { DONNA_BASE_INSTRUCTIONS, donnaAgent } from "./donna";
import { withPromptContext } from "../../shared/prompt-context";
import type { PmsEnvironment } from "../../shared/pms-scope";
import { userProfilePrompt, type PmsUserProfile } from "../pms/user-profile";

/** The exact text sent to the model for one user message. */
export function donnaPromptInput(message: string, environment?: PmsEnvironment, profile?: PmsUserProfile): string {
  return `${environment ? `<donna_pms_environment>${environment}</donna_pms_environment>\n` : ""}${userProfilePrompt(profile)}${withPromptContext(message)}`;
}

/**
 * Tokens a brand-new chat already occupies before the user types anything:
 * Donna's fixed instructions, her tool definitions, and the hidden context
 * that wraps every message. The per-user memory block is not included.
 */
export async function countBaselineContextTokens(
  environment: PmsEnvironment,
  signal?: AbortSignal,
): Promise<number> {
  const { model, tools } = donnaAgent;
  const instructions = DONNA_BASE_INSTRUCTIONS;
  if (typeof model !== "string") {
    throw new Error("Donna's model must be static to count tokens.");
  }

  const openai = new OpenAI();
  const count = await openai.responses.inputTokens.count(
    {
      model,
      instructions,
      input: donnaPromptInput("", environment),
      tools: tools.flatMap((tool) =>
        tool.type === "function"
          ? [{
              type: "function" as const,
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: tool.strict,
            }]
          : [],
      ),
    },
    { signal },
  );
  return count.input_tokens;
}
