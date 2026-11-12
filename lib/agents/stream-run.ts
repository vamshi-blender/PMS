import {
  RunContext,
  RunState,
  isOpenAIResponsesRawModelStreamEvent,
  run,
  type RunToolCallItem,
  type RunToolCallOutputItem,
  type RunToolApprovalItem,
} from "@openai/agents";
import { donnaAgent, type DonnaRunContext } from "./donna";
import { donnaPromptInput } from "./context-usage";
import { savePendingRun } from "./pending-runs";
import { toolArgumentsHash } from "../../shared/pms-scope";
import {
  CONFIRM_LABELS,
  encodeEvent,
  type AssistantPhase,
  type ChatStreamEvent,
  type ClientToolName,
  type ConfirmLabel,
  type ToolExecutor,
} from "./protocol";

const CLIENT_TOOL_NAMES = new Set<ClientToolName>([
  "get_current_page_context",
  "pms_lookup",
  "submit_pms_action",
]);

const PRIVATE_TOOL_ARGUMENTS = new Set([
  "approvalTitle",
  "approvalDescription",
  "confirmLabel",
]);
const TOOL_ARGUMENT_STRING_LIMIT = 800;
const TOOL_OUTPUT_PREVIEW_LIMIT = 1_200;

interface StreamDonnaRunOptions {
  input: string | RunState<DonnaRunContext, typeof donnaAgent>;
  conversationId: string;
  signal: AbortSignal;
  context?: DonnaRunContext;
}

interface TextSegment {
  itemId: string;
  phase: AssistantPhase;
}

function toolExecutor(name: string): ToolExecutor {
  return CLIENT_TOOL_NAMES.has(name as ClientToolName) ? "client" : "server";
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function publicToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args)
      .filter(([key]) => !PRIVATE_TOOL_ARGUMENTS.has(key))
      .map(([key, value]) => [
        key,
        typeof value === "string" && value.length > TOOL_ARGUMENT_STRING_LIMIT
          ? `${value.slice(0, TOOL_ARGUMENT_STRING_LIMIT)}…`
          : value,
      ]),
  );
}

function toolCallPresentation(item: RunToolCallItem): {
  callId: string;
  name: string;
  executor: ToolExecutor;
  arguments: Record<string, unknown>;
} | null {
  const callId = item.callId;
  const name = item.toolName;
  if (!callId || !name) return null;

  const args =
    item.rawItem.type === "function_call"
      ? parseArguments(item.rawItem.arguments)
      : {};

  return {
    callId,
    name,
    executor: toolExecutor(name),
    arguments: publicToolArguments(args),
  };
}

function toolOutputPreview(item: RunToolCallOutputItem): string | undefined {
  let output: string;
  try {
    output =
      typeof item.output === "string"
        ? item.output
        : JSON.stringify(item.output);
  } catch {
    return undefined;
  }

  if (!output) return undefined;
  return output.length > TOOL_OUTPUT_PREVIEW_LIMIT
    ? `${output.slice(0, TOOL_OUTPUT_PREVIEW_LIMIT)}…`
    : output;
}

function assistantPhase(value: unknown): AssistantPhase {
  return value === "commentary" ? "commentary" : "final_answer";
}

function asToolApprovalInterruption(
  interruption: RunToolApprovalItem,
): {
  toolCallId: string;
  name: string;
  executor: ToolExecutor;
  arguments: Record<string, unknown>;
} | null {
  const { rawItem } = interruption;
  if (rawItem.type !== "function_call") return null;

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(rawItem.arguments);
  } catch {
    return null;
  }

  if (
    !parsedArguments ||
    typeof parsedArguments !== "object" ||
    Array.isArray(parsedArguments)
  ) {
    return null;
  }

  return {
    toolCallId: rawItem.callId,
    name: rawItem.name,
    executor: toolExecutor(rawItem.name),
    arguments: parsedArguments as Record<string, unknown>,
  };
}

// The model generates the approval texts as part of the tool call itself
// (see approvalPresentationFields in donna.ts). Fall back to generic copy if
// a field is missing or malformed so the approval card never renders empty.
function approvalPresentation(args: Record<string, unknown>): {
  title: string;
  description: string;
  confirmLabel: ConfirmLabel;
} {
  const title =
    typeof args.approvalTitle === "string" && args.approvalTitle.trim()
      ? args.approvalTitle.trim().slice(0, 80)
      : "Allow Donna to perform this action?";
  let description =
    typeof args.approvalDescription === "string" && args.approvalDescription.trim()
      ? args.approvalDescription.trim().slice(0, 240)
      : "Donna needs your approval before it can continue with this request.";
  if (args.actionName === "add_worklog" && args.fields && typeof args.fields === "object") {
    const fields = args.fields as Record<string, unknown>;
    description = `${fields.issueId}: ${fields.issueSummary}\n${fields.logDate}; ${fields.category}; ${fields.logHours} hours (${fields.billableHours ?? fields.logHours} billable)\n${fields.description}`;
  }
  if (args.actionName === "change_issue_status" && args.fields && typeof args.fields === "object") {
    const fields = args.fields as Record<string, unknown>;
    const details = Array.isArray(fields.details) ? fields.details.map(item => {
      const detail = item as { field: string; value: string | null; values: string[] | null };
      return `${detail.field}: ${detail.values?.join(", ") ?? detail.value}`;
    }).join("; ") : "";
    description = `${fields.issueId}: ${fields.issueSummary}\n${fields.currentStatus} to ${fields.newStatus}${details ? "\n" + details : ""}`;
  }
  const confirmLabel = CONFIRM_LABELS.includes(args.confirmLabel as ConfirmLabel)
    ? (args.confirmLabel as ConfirmLabel)
    : "Allow";

  return { title, description, confirmLabel };
}

function publicError(error: unknown): ChatStreamEvent {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      type: "response.error",
      code: "cancelled",
      message: "Response stopped.",
    };
  }

  return {
    type: "response.error",
    code: "agent_error",
    message: "Donna could not complete that response. Please try again.",
  };
}

export function streamDonnaRun({
  input,
  conversationId,
  signal,
  context = { clientToolResults: {} },
}: StreamDonnaRunOptions): ReadableStream<Uint8Array> {
  const abortController = new AbortController();
  let cancelled = false;
  const abort = () => abortController.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) => {
        if (!cancelled && !abortController.signal.aborted) {
          controller.enqueue(encodeEvent(event));
        }
      };
      send({
        type: "response.started",
        requestId: crypto.randomUUID(),
        conversationId,
      });

      let completed: Promise<void> | undefined;
      try {
        abortController.signal.throwIfAborted();
        const isResumedRun = input instanceof RunState;
        const result = await run(donnaAgent, typeof input === "string"
          ? donnaPromptInput(input, context.scope?.environment) : input, {
          stream: true,
          signal: abortController.signal,
          maxTurns: 8,
          ...(isResumedRun
            ? {}
            : {
                context,
                conversationId,
              }),
        });

        completed = result.completed;
        // Observe early rejections while consuming the stream; always await
        // SDK tool cleanup before considering cancellation complete.
        void completed.catch(() => {});

        let startsNewSegment = true;
        let fallbackSegmentNumber = 0;
        let currentSegment: TextSegment = {
          itemId: `assistant-${fallbackSegmentNumber}`,
          phase: "final_answer",
        };
        const segmentsByOutputIndex = new Map<number, TextSegment>();
        // The latest model call's input already holds the whole conversation
        // (instructions, tools, history), so input + output of that one call
        // is what the conversation occupies now. Summing every call in the
        // run would count the history once per tool roundtrip.
        let contextTokens: number | undefined;

        for await (const event of result) {
          if (isOpenAIResponsesRawModelStreamEvent(event)) {
            const modelEvent = event.data.event;

            if (modelEvent.type === "response.created") {
              segmentsByOutputIndex.clear();
            } else if (modelEvent.type === "response.completed") {
              const usage = modelEvent.response.usage;
              if (usage) contextTokens = usage.input_tokens + usage.output_tokens;
            } else if (
              modelEvent.type === "response.output_item.added" &&
              modelEvent.item.type === "message"
            ) {
              const segment: TextSegment = {
                itemId:
                  modelEvent.item.id ||
                  `assistant-${++fallbackSegmentNumber}`,
                phase: assistantPhase(modelEvent.item.phase),
              };
              segmentsByOutputIndex.set(modelEvent.output_index, segment);
              currentSegment = segment;
              startsNewSegment = true;
            }

            continue;
          }

          if (
            event.type === "run_item_stream_event" &&
            event.name === "message_output_created"
          ) {
            startsNewSegment = true;
            continue;
          }

          if (
            event.type === "run_item_stream_event" &&
            event.name === "tool_called" &&
            event.item.type === "tool_call_item"
          ) {
            const toolCall = toolCallPresentation(event.item);
            if (toolCall) {
              send({
                type: "tool.started",
                ...toolCall,
                startedAt: Date.now(),
              });
            }
            continue;
          }

          if (
            event.type === "run_item_stream_event" &&
            event.name === "tool_output" &&
            event.item.type === "tool_call_output_item"
          ) {
            const callId = event.item.callId;
            if (callId) {
              const output = toolOutputPreview(event.item);
              send({
                type: "tool.completed",
                callId,
                ...(output ? { output } : {}),
                completedAt: Date.now(),
              });
            }
            continue;
          }

          if (
            event.type === "raw_model_stream_event" &&
            event.data.type === "output_text_delta"
          ) {
            if (!event.data.delta) continue;

            const outputIndex = event.data.providerData?.output_index;
            const segment =
              typeof outputIndex === "number"
                ? segmentsByOutputIndex.get(outputIndex) ?? currentSegment
                : currentSegment;

            send({
              type: "response.delta",
              delta: event.data.delta,
              itemId: segment.itemId,
              phase: segment.phase,
              ...(startsNewSegment ? { startsNewSegment: true } : {}),
            });
            startsNewSegment = false;
          }
        }

        await result.completed;
        abortController.signal.throwIfAborted();

        const approval = result.interruptions
          .map(asToolApprovalInterruption)
          .find((candidate) => candidate !== null);

        if (approval) {
          const argumentsHash = await toolArgumentsHash(approval.name, approval.arguments);
          const runId = savePendingRun({
            serializedState: result.state.toString(),
            state: result.state,
            context,
            conversationId,
            toolCallId: approval.toolCallId,
            toolName: approval.name,
            executor: approval.executor,
            argumentsHash,
          });

          send({
            type: "tool_approval.request",
            runId,
            toolCallId: approval.toolCallId,
            name: approval.name,
            executor: approval.executor,
            arguments: approval.arguments,
            ...approvalPresentation(approval.arguments),
            ...(context.scope ? {
              scope: context.scope, conversationId, argumentsHash,
              description: `${context.scope.environment === "production" ? "Production" : "Staging"} PMS\n${approvalPresentation(approval.arguments).description}`,
            } : {}),
            requiresApproval: true,
          });
          send({
            type: "response.paused",
            runId,
            pausedAt: Date.now(),
            ...(contextTokens === undefined ? {} : { contextTokens }),
          });
          return;
        }

        if (result.interruptions.length > 0) {
          // A paused run we cannot surface must not masquerade as a completed
          // response — the user would wait on an answer that never arrives.
          send({
            type: "response.error",
            code: "unsupported_interruption",
            message: "Donna paused for an approval it could not display. Please try again.",
          });
          return;
        }

        send({
          type: "response.completed",
          conversationId,
          ...(contextTokens === undefined ? {} : { contextTokens }),
        });
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("Donna agent run failed", error);
          send(publicError(error));
        }
      } finally {
        await completed?.catch(() => {});
        signal.removeEventListener("abort", abort);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      abortController.abort();
    },
  });
}

export async function restoreRunState(
  serializedState: string,
  context: DonnaRunContext,
) {
  return RunState.fromStringWithContext(
    donnaAgent,
    serializedState,
    new RunContext(context),
    { contextStrategy: "replace" },
  );
}
