import type { ToolExecutor } from "./protocol";
import type { RunState } from "@openai/agents";
import type { donnaAgent, DonnaRunContext } from "./donna";

const PENDING_RUN_TTL_MS = 10 * 60 * 1000;

export interface PendingRun {
  serializedState: string;
  state?: RunState<DonnaRunContext, typeof donnaAgent>;
  context?: DonnaRunContext;
  claimId?: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  executor: ToolExecutor;
  createdAt: number;
}

declare global {
  var __donnaPendingRuns: Map<string, PendingRun> | undefined;
}

const pendingRuns =
  globalThis.__donnaPendingRuns ?? new Map<string, PendingRun>();

// Route bundles must share checkpoints in production as well as development.
globalThis.__donnaPendingRuns = pendingRuns;

function removeExpiredRuns() {
  const cutoff = Date.now() - PENDING_RUN_TTL_MS;
  for (const [runId, pending] of pendingRuns) {
    if (pending.createdAt < cutoff) pendingRuns.delete(runId);
  }
}

export function savePendingRun(run: Omit<PendingRun, "createdAt">): string {
  removeExpiredRuns();
  const runId = crypto.randomUUID();
  pendingRuns.set(runId, { ...run, createdAt: Date.now() });
  return runId;
}

export function getPendingRun(runId: string, toolCallId: string): PendingRun | undefined {
  removeExpiredRuns();
  const pending = pendingRuns.get(runId);
  return pending?.toolCallId === toolCallId ? pending : undefined;
}

export function claimPendingRun(runId: string, toolCallId: string): string | undefined {
  const pending = getPendingRun(runId, toolCallId);
  if (!pending || pending.claimId) return undefined;
  pending.claimId = crypto.randomUUID();
  return pending.claimId;
}

// Check identity and consume synchronously, after all asynchronous validation.
// Concurrent resume requests can never both approve the same checkpoint.
export function takePendingRun(runId: string, expected: PendingRun): PendingRun | undefined {
  removeExpiredRuns();
  const pending = pendingRuns.get(runId);
  if (pending !== expected) return undefined;
  pendingRuns.delete(runId);
  return pending;
}
