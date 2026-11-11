import type { PmsScope } from "../../shared/pms-scope";

export type ClientToolName =
  | "get_current_page_context"
  | "pms_lookup"
  | "submit_pms_action";

export type ToolExecutor = "client" | "server";

export type AssistantPhase = "commentary" | "final_answer";

export const CONFIRM_LABELS = [
  "Allow",
  "Run",
  "Send",
  "Update",
  "Confirm",
  "Approve",
] as const;

export type ConfirmLabel = (typeof CONFIRM_LABELS)[number];

export type ChatStreamEvent =
  | {
      type: "response.started";
      requestId: string;
      conversationId: string;
    }
  | {
      type: "response.delta";
      delta: string;
      itemId: string;
      phase: AssistantPhase;
      startsNewSegment?: true;
    }
  | {
      type: "tool.started";
      callId: string;
      name: string;
      executor: ToolExecutor;
      arguments: Record<string, unknown>;
      startedAt: number;
    }
  | {
      type: "tool.completed";
      callId: string;
      output?: string;
      completedAt: number;
    }
  | {
      type: "tool_approval.request";
      runId: string;
      toolCallId: string;
      name: string;
      executor: ToolExecutor;
      arguments: Record<string, unknown>;
      title: string;
      description: string;
      confirmLabel: ConfirmLabel;
      requiresApproval: true;
      scope?: PmsScope;
      conversationId?: string;
      argumentsHash?: string;
    }
  | {
      type: "response.paused";
      runId: string;
      pausedAt: number;
    }
  | {
      type: "response.completed";
      conversationId: string;
    }
  | {
      type: "response.error";
      code: string;
      message: string;
    };

export function encodeEvent(event: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}
