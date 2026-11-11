import { z } from "zod";

export const pmsScopeSchema = z.object({
  environment: z.enum(["staging", "production"]),
  userId: z.string().min(1).max(200),
  organizationId: z.string().min(1).max(200),
  sessionId: z.string().uuid(),
}).strict();

export type PmsScope = z.infer<typeof pmsScopeSchema>;
export type PmsEnvironment = PmsScope["environment"];

export function samePmsScope(a: PmsScope, b: PmsScope): boolean {
  return a.environment === b.environment && a.userId === b.userId &&
    a.organizationId === b.organizationId && a.sessionId === b.sessionId;
}

// A stable fingerprint binds the approved arguments and tool name. Object
// property order must not change the fingerprint after JSON transport.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function toolArgumentsHash(name: string, args: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ name, arguments: args }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
