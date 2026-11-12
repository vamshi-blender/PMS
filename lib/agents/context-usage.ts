import OpenAI from "openai";
import { donnaAgent } from "./donna";
import { withPromptContext } from "../../shared/prompt-context";
import type { PmsEnvironment } from "../../shared/pms-scope";

/** The exact text sent to the model for one user message. */
export function donnaPromptInput(message: string, environment?: PmsEnvironment): string {
  return `${environment ? `<donna_pms_environment>${environment}</donna_pms_environment>\n` : ""}${withPromptContext(message)}`;
}

/**
 * Tokens a brand-new chat already occupies before the user types anything:
 * Donna's instructions, her tool definitions, and the hidden context that
 * wraps every message.
 */
export async function countBaselineContextTokens(
  environment: PmsEnvironment,
  signal?: AbortSignal,
): Promise<number> {
  const { instructions, model, tools } = donnaAgent;
  if (typeof instructions !== "string" || typeof model !== "string") {
    throw new Error("Donna's instructions and model must be static to count tokens.");
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
