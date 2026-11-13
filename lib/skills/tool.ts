import { tool } from "@openai/agents";
import { z } from "zod";
import type { DonnaRunContext } from "../agents/donna";
import { proposeSkill, readSkill, skillsConfigured, type SkillDraft } from "./store";

export const proceduralMemoryParameters = z.object({
  action: z.enum(["read", "add", "update", "delete"]),
  skill: z.string().min(1).max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .describe("Skill key from the automatic catalog, or a new lowercase-hyphenated key for add."),
  expectedVersion: z.number().int().positive().nullable()
    .describe("Current approved version from read; required for update/delete, null for read/add."),
  name: z.string().trim().min(1).max(120).nullable().describe("Display name, required for add/update; null otherwise."),
  description: z.string().trim().min(1).max(500).nullable().describe("Short catalog description, required for add/update; null otherwise."),
  whenToUse: z.string().trim().min(1).max(500).nullable().describe("Requests that should activate this skill, required for add/update; null otherwise."),
  instructions: z.string().trim().min(1).max(20_000).nullable().describe("Full Markdown procedure, required for add/update; null otherwise. Policies belong in organization memory, not duplicated here."),
}).strict();
export type ProceduralMemoryInput = z.infer<typeof proceduralMemoryParameters>;

export async function runProceduralMemoryAction(context: DonnaRunContext | undefined, input: ProceduralMemoryInput): Promise<string> {
  const parsed = proceduralMemoryParameters.safeParse(input);
  if (!parsed.success) return JSON.stringify({ ok: false, error: "Invalid procedural memory inputs." });
  if (!context?.scope || !skillsConfigured()) return JSON.stringify({ ok: false, error: "Procedural memory is unavailable in this chat." });
  input = parsed.data;
  try {
    if (input.action === "read") {
      const pinned = context.loadedSkills?.find(item => item.skill === input.skill);
      if (pinned) return JSON.stringify({ ok: true, skill: pinned.skill, version: pinned.version, alreadyLoaded: true, note: "Full instructions are already loaded in this run; use the earlier tool result." });
      const skill = await readSkill(context.scope, input.skill);
      if (!skill) return JSON.stringify({ ok: false, error: "No approved skill with that name is available in this organization and environment." });
      (context.loadedSkills ??= []).push(skill);
      // Return full approved instructions once; subsequent model calls see activation metadata.
      return JSON.stringify({ ok: true, ...skill });
    }
    const { name, description, whenToUse, instructions } = input;
    if ((input.action === "add" || input.action === "update") && (!name || !description || !whenToUse || !instructions)) {
      return JSON.stringify({ ok: false, error: "name, description, whenToUse and instructions are required for add/update." });
    }
    const draft: SkillDraft | null = name && description && whenToUse && instructions
      ? { name, description, whenToUse, instructions } : null;
    const result = await proposeSkill(context.scope, input.action, input.skill, input.expectedVersion, draft, context.conversationId);
    return JSON.stringify({ ok: true, ...result, status: "pending", proposedAction: input.action,
      note: "Proposal saved for manual review in Supabase. The currently approved procedure remains in effect until an administrator changes this proposal's status to approved." });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Procedural memory is unavailable." });
  }
}

export const manageProceduralMemory = tool<typeof proceduralMemoryParameters, DonnaRunContext, string>({
  name: "manage_procedural_memory",
  description: "Read full approved skill instructions when the automatic catalog matches the task, or propose add/update/delete. All writes stay pending for manual Supabase review. No list or approval action exists. Never use ordinary manage_memory to store procedures.",
  parameters: proceduralMemoryParameters,
  async execute(input, runContext) { return runProceduralMemoryAction(runContext?.context, input); },
});
