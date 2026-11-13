import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PmsScope } from "../../shared/pms-scope";

export type SkillOwner = Pick<PmsScope, "environment" | "organizationId" | "userId">;
export interface SkillSummary {
  id: number;
  skill: string;
  version: number;
  name: string;
  description: string;
  whenToUse: string;
}
export interface Skill extends SkillSummary { instructions: string }
export interface SkillDraft {
  name: string;
  description: string;
  whenToUse: string;
  instructions: string;
}
export type SkillChange = "add" | "update" | "delete";
declare global { var __donnaSkillStore: SupabaseClient | undefined; }

export function skillsConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function database(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Skills are not configured.");
  return globalThis.__donnaSkillStore ??= createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) },
  });
}

const SUMMARY_COLUMNS = "id,skill_key,version,name,description,when_to_use";
type Row = Record<string, unknown>;
function summary(row: Row): SkillSummary {
  return { id: Number(row.id), skill: String(row.skill_key), version: Number(row.version),
    name: String(row.name), description: String(row.description), whenToUse: String(row.when_to_use) };
}

/** Metadata only: full instructions never enter the automatic catalog. */
export async function loadSkillCatalog(owner: SkillOwner): Promise<SkillSummary[]> {
  const rows: SkillSummary[] = [];
  // Read every page: catalog discovery must not silently omit skills.
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await database().from("procedural_memories").select(SUMMARY_COLUMNS)
      .eq("environment", owner.environment).eq("organization_id", owner.organizationId)
      .eq("status", "approved").neq("proposed_action", "delete")
      .order("skill_key").range(offset, offset + 99);
    if (error) throw new Error("Could not load procedural memory.");
    rows.push(...data.map(summary));
    if (data.length < 100) return rows;
  }
}

export async function readSkill(owner: SkillOwner, skill: string): Promise<Skill | null> {
  const { data, error } = await database().from("procedural_memories")
    .select(`${SUMMARY_COLUMNS},instructions`)
    .eq("environment", owner.environment).eq("organization_id", owner.organizationId)
    .eq("skill_key", skill).eq("status", "approved").neq("proposed_action", "delete").maybeSingle();
  if (error) throw new Error("Could not read the approved skill.");
  return data ? { ...summary(data), instructions: String(data.instructions) } : null;
}

/** The tool only INSERTs pending rows; approving/rejecting is manual in Supabase. */
export async function proposeSkill(
  owner: SkillOwner, action: SkillChange, skill: string, expectedVersion: number | null,
  draft: SkillDraft | null, conversationId?: string,
): Promise<{ id: number; version: number }> {
  const client = database();
  const { data: current, error: readError } = await client.from("procedural_memories")
    .select("id,version,proposed_action,name,description,when_to_use,instructions")
    .eq("environment", owner.environment).eq("organization_id", owner.organizationId)
    .eq("skill_key", skill).eq("status", "approved").maybeSingle();
  if (readError) throw new Error("Could not check the current skill.");
  const exists = current && current.proposed_action !== "delete";
  if (action === "add" && exists) throw new Error("This skill already exists. Read it and propose an update.");
  if (action !== "add" && (!exists || expectedVersion !== Number(current.version))) {
    throw new Error("The approved skill is missing or its version changed. Read it before proposing a change.");
  }
  const fields = action === "delete" ? {
    name: current!.name, description: current!.description,
    whenToUse: current!.when_to_use, instructions: current!.instructions,
  } : draft!;
  const { data, error } = await client.from("procedural_memories").insert({
    environment: owner.environment, organization_id: owner.organizationId, skill_key: skill,
    name: fields.name, description: fields.description, when_to_use: fields.whenToUse,
    instructions: fields.instructions, proposed_action: action, status: "pending",
    replaces_id: current?.id ?? null, proposed_by_user_id: owner.userId,
    source_conversation_id: conversationId ?? null,
  }).select("id,version").single();
  if (error) throw new Error("Could not save the proposal. Read the current skill before trying again; approval may have changed it.");
  return { id: Number(data.id), version: Number(data.version) };
}
