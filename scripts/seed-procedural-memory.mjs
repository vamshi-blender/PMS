import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import seeds from "../lib/skills/seeds.json" with { type: "json" };

nextEnv.loadEnvConfig(process.cwd(), true);
const organizationId = process.argv[2];
if (!organizationId) throw new Error("Usage: node scripts/seed-procedural-memory.mjs <verified-PMS-organization-id>");
const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
if (!url || !key) throw new Error("Supabase credentials are required.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

for (const environment of ["staging", "production"]) {
  for (const seed of seeds) {
    const { data: existing, error: checkError } = await db.from("procedural_memories").select("id,status")
      .eq("environment", environment).eq("organization_id", organizationId).eq("skill_key", seed.skill).limit(1);
    if (checkError) throw new Error(checkError.message);
    // Rerunning must never undo a human edit, rejection or retirement.
    if (existing.length) { console.log(`${environment}/${seed.skill}: already exists, left unchanged`); continue; }
    const { data: row, error } = await db.from("procedural_memories").insert({
      environment, organization_id: organizationId, skill_key: seed.skill,
      name: seed.name, description: seed.description, when_to_use: seed.whenToUse,
      instructions: seed.instructions, proposed_action: "add", status: "pending",
      proposed_by_user_id: "system:initial-skill-seed",
    }).select("id").single();
    if (error) throw new Error(error.message);
    // Initial skills are explicitly approved by this administrator-run seed.
    const { error: approvalError } = await db.from("procedural_memories").update({ status: "approved" }).eq("id", row.id);
    if (approvalError) throw new Error(approvalError.message);
    console.log(`${environment}/${seed.skill}: approved`);
  }
}
