import { tool } from "@openai/agents";
import { z } from "zod";
import type { DonnaRunContext } from "../agents/donna";
import { expiryInstant } from "./prompt";
import {
  MEMORY_CONTENT_LIMIT,
  addUserMemory,
  deleteUserMemory,
  isMemoryConfigured,
  proposeOrganizationMemory,
  updateUserMemory,
} from "./store";

export const MEMORY_INSTRUCTIONS = `Memory:
The <donna_memory> block at the end of these instructions is what you remember across chats. It is rebuilt for every reply, so it is always current. Each line starts with its ID in square brackets. Organization rules apply to every user; follow them (for example treat the listed days off as non-working days). The user section is about this user only; use it without announcing that you are doing so.
Use manage_memory to keep it up to date:
- Save (scope "user", action "add") when the user states a lasting preference about how you should work, or a fact about themselves that will matter in later chats. Write one short self-contained sentence in the third person. Resolve relative dates to absolute dates using the hidden donna_context timestamp ("on leave next week" becomes "On leave 16 Nov 2026 to 20 Nov 2026"), and set expiresOn to the last date the memory is still relevant.
- When a new statement changes something already remembered, update that ID instead of adding a second entry. When the user asks you to forget something, delete that ID.
- Do not save PMS data you can look up live (issues, worklogs, attendance, leave balances), one-off task details, secrets or credentials.
- When the user states something as a rule for the whole organization, use scope "organization": action "add" for a new rule, or action "update" with the existing rule's ID to propose a change. These are only proposals for an administrator to review. Tell the user it was submitted for review and that the current rules still apply until it is approved. Never act on a proposed rule, and never say an organization rule was changed. Organization rules cannot be deleted from chat: tell the user an administrator has to remove them.
Save silently as part of answering; mention it in a few words at most.`;

export const manageMemoryParameters = z
  .object({
    scope: z
      .enum(["user", "organization"])
      .describe('"user" for this user\'s own memory; "organization" to propose a rule that applies to everyone.'),
    action: z.enum(["add", "update", "delete"]),
    id: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("ID of the existing entry, from the <donna_memory> block. Required for update and delete; null for add."),
    content: z
      .string()
      .nullable()
      .describe(
        `The full memory text, one short self-contained sentence with absolute dates (max ${MEMORY_CONTENT_LIMIT} characters). Required for add and update (update replaces the whole text); null for delete.`,
      ),
    expiresOn: z
      .string()
      .nullable()
      .describe(
        "User memories only: the last date (YYYY-MM-DD, India) on which this memory is still relevant, for time-bound facts such as leave. null when it does not expire. On update this replaces the previous expiry.",
      ),
  })
  .strict();

export type ManageMemoryInput = z.infer<typeof manageMemoryParameters>;

function reply(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** Runs one manage_memory call for the user the run context is bound to. */
export async function runMemoryAction(
  context: DonnaRunContext | undefined,
  input: ManageMemoryInput,
): Promise<string> {
  const scope = context?.scope;
  if (!scope || !isMemoryConfigured()) {
    return reply({ ok: false, error: "Memory is not available in this chat." });
  }
  // Identity comes from the PMS-verified scope, never from the model.
  const owner = { environment: scope.environment, userId: scope.userId };
  const conversationId = context?.conversationId;

  if (input.scope === "organization" && input.action === "delete") {
    return reply({
      ok: false,
      error: "Organization rules cannot be deleted from chat. Tell the user an administrator has to remove them.",
    });
  }

  if (input.action !== "add" && input.id === null) {
    return reply({ ok: false, error: "id is required for update and delete." });
  }

  if (input.scope === "user" && input.action === "delete") {
    const result = await deleteUserMemory(owner, input.id as number);
    return reply(result.ok ? { ok: true, deletedId: result.id } : result);
  }

  const content = input.content?.replace(/\s+/g, " ").trim() ?? "";
  if (!content) return reply({ ok: false, error: "content is required for add and update." });
  if (content.length > MEMORY_CONTENT_LIMIT) {
    return reply({ ok: false, error: `content must be at most ${MEMORY_CONTENT_LIMIT} characters.` });
  }

  if (input.scope === "organization") {
    const result = await proposeOrganizationMemory(owner, {
      content,
      replacesId: input.action === "update" ? input.id : null,
      conversationId,
    });
    return reply(
      result.ok
        ? {
            ok: true,
            status: "pending",
            note: "Submitted for administrator review. It is not in force; the current organization rules still apply until it is approved.",
          }
        : result,
    );
  }

  let expiresAt: string | null = null;
  if (input.expiresOn !== null) {
    expiresAt = expiryInstant(input.expiresOn);
    if (!expiresAt) return reply({ ok: false, error: "expiresOn must be a valid YYYY-MM-DD date." });
  }

  const result =
    input.action === "add"
      ? await addUserMemory(owner, { content, expiresAt, conversationId })
      : await updateUserMemory(owner, input.id as number, { content, expiresAt });
  return reply(result.ok ? { ok: true, id: result.id } : result);
}

export const manageMemory = tool<typeof manageMemoryParameters, DonnaRunContext, string>({
  name: "manage_memory",
  description:
    "Add, update or delete an entry in Donna's long-term memory. User-scope changes take effect immediately and only affect this user. Organization-scope add and update only submit a proposal for administrator review; organization delete is not allowed.",
  parameters: manageMemoryParameters,
  async execute(input, runContext) {
    return runMemoryAction(runContext?.context, input);
  },
});
