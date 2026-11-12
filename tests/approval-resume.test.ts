import { afterEach, describe, expect, it, vi } from "vitest";
import { setTracingDisabled } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall } from "@openai/agents/testing";
import { donnaAgent } from "../lib/agents/donna";
import { getPendingRun, savePendingRun, takePendingRun } from "../lib/agents/pending-runs";
import { streamDonnaRun } from "../lib/agents/stream-run";
import { POST } from "../app/api/chat/resume/route";
import { POST as claim } from "../app/api/chat/claim/route";

// Authentication is covered in api-auth.test.ts; these tests exercise what
// happens after a caller is accepted.
vi.mock("../lib/http/auth", () => ({
  requireCaller: async () => ({ kind: "dev" }), callerOwnsScope: () => true, scopeForbidden: () => new Response(null, { status: 403 }),
}));
setTracingDisabled(true);
const originalModel = donnaAgent.model;
const scope = { environment: "staging" as const, userId: "user", organizationId: "org", sessionId: "00000000-0000-4000-8000-000000000001" };
afterEach(() => {
  donnaAgent.model = originalModel;
  globalThis.__donnaPendingRuns?.clear();
  vi.useRealTimers();
});

async function pause() {
  const model = new ScriptedModel([
    [functionCall("get_current_page_context", {
      includeSelection: false,
      maxCharacters: 500,
      approvalTitle: "Read this page?",
      approvalDescription: "Read the active page.",
      confirmLabel: "Allow",
    }, { callId: "call-page" })],
    [assistantMessage("Finished.")],
  ]);
  donnaAgent.model = model;
  const response = new Response(streamDonnaRun({
    input: "Read this page",
    context: { clientToolResults: {}, scope },
    conversationId: "conv-test",
    signal: new AbortController().signal,
  }));
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  const approval = events.find((event) => event.type === "tool_approval.request");
  expect(approval).toBeDefined();
  return { approval, model };
}

async function resume(body: Record<string, unknown>) {
  const saved = getPendingRun(body.runId as string, body.toolCallId as string);
  body = { scope: saved?.context?.scope ?? scope, conversationId: saved?.conversationId ?? "conv-test", argumentsHash: saved?.argumentsHash ?? "0".repeat(64), ...body };
  if (body.approved && !body.claimId) {
    const pending = getPendingRun(body.runId as string, body.toolCallId as string);
    if (pending) {
      if (!pending.claimId) {
        await claim(new Request("http://localhost/api/chat/claim", {
          method: "POST", body: JSON.stringify({ runId: body.runId, toolCallId: body.toolCallId, scope: body.scope, conversationId: body.conversationId, argumentsHash: body.argumentsHash }),
        }));
      }
      body = { ...body, claimId: pending.claimId };
    }
  }
  return POST(new Request("http://localhost/api/chat/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("approval checkpoints", () => {
  it("shows the issue transition and supplied details before executing", async () => {
    const model = new ScriptedModel([[functionCall("submit_pms_action", {
      actionName: "change_issue_status", fields: {
        issueId: "QKA-49715", issueSummary: "Team Cordination", currentStatus: "In Progress", newStatus: "Resolved",
        details: [{ field: "Change Remarks", value: "Work complete", values: null }],
      }, approvalTitle: "Change status?", approvalDescription: "Model summary", confirmLabel: "Allow",
    }, { callId: "call-status" })], [assistantMessage("Changed status.")]]);
    donnaAgent.model = model;
    const response = new Response(streamDonnaRun({ input: "Resolve QKA-49715", context: { clientToolResults: {}, scope: { ...scope, environment: "production" } }, conversationId: "conv-status", signal: new AbortController().signal }));
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    const approval = events.find(event => event.type === "tool_approval.request");
    expect(approval.description).toContain("Production PMS");
    expect(approval.scope.environment).toBe("production");
    expect(approval.description).toContain("QKA-49715: Team Cordination");
    expect(approval.description).toContain("In Progress to Resolved");
    expect(approval.description).toContain("Change Remarks: Work complete");
    expect(model.calls).toHaveLength(1);
    const resumed = await resume({ runId: approval.runId, toolCallId: approval.toolCallId, approved: true, result: { status: "Resolved" } });
    expect(await resumed.text()).toContain("response.completed");
    model.assertComplete();
  });
  it("claims a browser action once before execution and rejects other claim owners", async () => {
    const { approval } = await pause();
    const body = { runId: approval.runId, toolCallId: approval.toolCallId, scope: approval.scope, conversationId: approval.conversationId, argumentsHash: approval.argumentsHash };
    const request = () => new Request("http://localhost/api/chat/claim", { method: "POST", body: JSON.stringify(body) });
    const claims = await Promise.all([claim(request()), claim(request())]);
    expect(claims.map((response) => response.status).sort()).toEqual([200, 409]);
    const invalidOwner = await POST(new Request("http://localhost/api/chat/resume", {
      method: "POST", body: JSON.stringify({ ...body, approved: false }),
    }));
    expect(invalidOwner.status).toBe(409);
    expect(getPendingRun(approval.runId, approval.toolCallId)).toBeDefined();
  });
  it("rejects changed approval environment, user, session, conversation and inputs before claiming or consuming", async () => {
    const { approval } = await pause();
    const binding = { runId: approval.runId, toolCallId: approval.toolCallId, scope: approval.scope,
      conversationId: approval.conversationId, argumentsHash: approval.argumentsHash };
    const variants = [
      { scope: { ...scope, environment: "production" } },
      { scope: { ...scope, userId: "someone-else" } },
      { scope: { ...scope, organizationId: "other-org" } },
      { scope: { ...scope, sessionId: "00000000-0000-4000-8000-000000000002" } },
      { conversationId: "other-conversation" }, { argumentsHash: "f".repeat(64) },
    ];
    for (const variant of variants) {
      const body = { ...binding, ...variant };
      expect((await claim(new Request("http://localhost/api/chat/claim", { method: "POST", body: JSON.stringify(body) }))).status).toBe(409);
      expect((await POST(new Request("http://localhost/api/chat/resume", { method: "POST", body: JSON.stringify({ ...body, approved: false }) }))).status).toBe(409);
      expect(getPendingRun(approval.runId, approval.toolCallId)?.claimId).toBeUndefined();
    }
  });
  it("keeps a checkpoint after a wrong call ID or oversized result, then resumes once", async () => {
    const { approval, model } = await pause();
    const body = { runId: approval.runId, toolCallId: approval.toolCallId, approved: true };
    expect((await resume({ ...body, toolCallId: "wrong" })).status).toBe(410);
    expect((await resume({ ...body, result: "x".repeat(60_001) })).status).toBe(413);
    const pending = getPendingRun(approval.runId, approval.toolCallId);
    expect(pending?.state).toBeDefined();
    const response = await resume({ ...body, result: { title: "Page" } });
    expect(response.status).toBe(200);
    const output = await response.text();
    expect(output).toContain('"type":"response.completed"');
    expect(output).not.toContain('"type":"response.error"');
    expect(pending?.context?.clientToolResults[approval.toolCallId]).toEqual({ ok: true, data: { title: "Page" } });
    expect((await resume(body)).status).toBe(410);
    model.assertComplete();
  });

  it("admits an alternative instruction as user input without executing the rejected tool", async () => {
    const { approval, model } = await pause();
    const response = await resume({
      runId: approval.runId, toolCallId: approval.toolCallId,
      approved: false, instruction: "Tell me the time instead.",
    });
    expect(await response.text()).toContain('"type":"response.completed"');
    const input = model.lastCall?.request.input;
    expect(JSON.stringify(input)).toContain("Tell me the time instead.");
    expect(JSON.stringify(input)).toContain("The user declined this request.");
  });

  it("allows only one of two simultaneous resume requests", async () => {
    const { approval, model } = await pause();
    const body = { runId: approval.runId, toolCallId: approval.toolCallId, approved: true, result: {} };
    const responses = await Promise.all([resume(body), resume(body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 410]);
    await Promise.all(responses.map((response) => response.text()));
    model.assertComplete();
  });

  it("restores a serialized checkpoint when its live state is unavailable", async () => {
    const { approval, model } = await pause();
    const pending = getPendingRun(approval.runId, approval.toolCallId)!;
    pending.state = undefined;
    const response = await resume({
      runId: approval.runId, toolCallId: approval.toolCallId,
      approved: true, result: { title: "Restored" },
    });
    expect(await response.text()).toContain('"type":"response.completed"');
    expect(JSON.stringify(model.lastCall?.request.input)).toContain("Restored");
    model.assertComplete();
  });

  it("expires checkpoints and refuses a stale consume reference", () => {
    vi.useFakeTimers();
    const runId = savePendingRun({ serializedState: "{}", conversationId: "conv", toolCallId: "call", toolName: "tool", executor: "client" });
    const pending = getPendingRun(runId, "call")!;
    expect(takePendingRun(runId, { ...pending })).toBeUndefined();
    expect(getPendingRun(runId, "call")).toBe(pending);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(takePendingRun(runId, pending)).toBeUndefined();
  });
});
