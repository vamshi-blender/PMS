// Bridges the manifest bundle to Donna's tool layer: generates the Zod
// schema for submit_pms_action's fields from a manifest's input slots
// ("adding a manifest gives Donna a new capability, no new tool"), and the
// capabilities catalog list_pms_capabilities returns. Single source of
// truth: the manifest files.
import { z } from "zod";
import { getPmsBundle } from "./bundle";
import type { PmsInputSlot, PmsLookupSource } from "./types";
import type { PmsEnvironment } from "../../shared/pms-scope";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function transitionDetailsSchema(fields: string[]) {
  return z.array(z.object({
    field: z.enum(fields as [string, ...string[]]),
    value: z.string().nullable(), values: z.array(z.string()).nullable(),
  }).strict());
}

function slotSchema(slot: PmsInputSlot): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (slot.type) {
    case "enum":
      schema = z.enum((slot.options ?? []) as [string, ...string[]]);
      break;
    case "date":
      schema = z.string().regex(DATE_PATTERN, "Expected YYYY-MM-DD");
      break;
    case "details":
      schema = transitionDetailsSchema(slot.options ?? []);
      break;
    case "boolean":
      schema = z.boolean();
      break;
    default:
      schema = slot.maxLength
        ? z.string().min(1).max(slot.maxLength)
        : z.string().min(1);
  }
  schema = schema.describe(slot.description);
  // Structured outputs require every key present; optional slots are
  // expressed as nullable, mirroring the existing tool conventions.
  return slot.required ? schema : schema.nullable();
}

export function actionFieldsShape(
  slots: PmsInputSlot[],
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const slot of slots) shape[slot.name] = slotSchema(slot);
  return shape;
}

/** Functional catalog for list_pms_capabilities — what Donna can do in PMS. */
export function capabilitiesCatalog(environment: PmsEnvironment = "staging"): unknown {
  const bundle = getPmsBundle(environment);
  return {
    environment,
    actions: Object.entries(bundle.actions).map(([actionName, manifest]) => ({
      actionName,
      title: manifest.title,
      description: manifest.description,
      userFields: manifest.inputs.map((slot) => ({
        name: slot.name,
        label: slot.label,
        type: slot.type,
        options: slot.options ?? null,
        required: slot.required,
        description: slot.description,
      })),
      businessRules: manifest.rules.map((rule) => rule.message),
      confirmation:
        "The extension shows an in-UI approval card before executing; do not ask for verbal confirmation in chat.",
      executedBy: "the Chrome extension, locally with the user's PMS session",
    })),
    lookups: Object.entries(bundle.lookups)
      .filter(([, lookup]) => lookup.queryable)
      .map(([name, lookup]) => ({
        parameters: lookup.source.kind === "issueContext" || lookup.source.kind === "worklogReport" || lookup.source.kind === "issueTransitions"
          ? { issueId: "Required: full issue ID or unique numeric suffix" }
          : lookup.source.kind === "dailyWorklogs" || lookup.source.kind === "attendanceReport"
            ? { [lookup.source.kind === "dailyWorklogs" ? "logDate" : "date"]: "YYYY-MM-DD in India for one day; omit when supplying a range",
              fromDate: "Inclusive YYYY-MM-DD range start; supply toDate too, at most 366 days",
              toDate: "Inclusive YYYY-MM-DD range end", excludeWeekends: "true to omit Saturdays and Sundays from details and summaries" } : {},
        resolverName: name,
        description: lookup.description,
        ...lookupQueryCapabilities(lookup.source),
      })),
  };
}

/** Union of filterable field names across queryable lookups. Feeds the
 * pms_lookup tool's `field` enum so the model cannot emit a name that exists
 * nowhere (per-lookup membership is still validated by the executor). */
export function queryableFilterFieldNames(): string[] {
  const names = new Set<string>();
  for (const lookup of Object.values(getPmsBundle().lookups)) {
    if (!lookup.queryable || lookup.source.kind !== "reportGrid") continue;
    for (const field of lookup.source.filterableFields ?? []) {
      names.add(field.name);
    }
  }
  return [...names];
}

/** Union of selectable column names across queryable lookups — same role as
 * queryableFilterFieldNames, for the `columns` param. */
export function queryableColumnNames(): string[] {
  const names = new Set<string>();
  for (const lookup of Object.values(getPmsBundle().lookups)) {
    if (!lookup.queryable) continue;
    for (const column of availableColumnsOf(lookup.source)) names.add(column);
  }
  return [...names];
}

/** One-line per-lookup map for tool descriptions, so the model picks valid
 * names without a list_pms_capabilities roundtrip. */
export function lookupQuerySummary(): string {
  return Object.entries(getPmsBundle().lookups)
    .filter(([, lookup]) => lookup.queryable)
    .map(([name, lookup]) => {
      const fields =
        lookup.source.kind === "reportGrid"
          ? (lookup.source.filterableFields ?? []).map((field) => field.name)
          : [];
      const columns = availableColumnsOf(lookup.source);
      const filterPart = fields.length
        ? `filters: ${fields.join(" | ")}`
        : "no filters";
      return `${name} — ${filterPart}; columns: ${columns.join(" | ")}`;
    })
    .join(". ");
}

function availableColumnsOf(source: PmsLookupSource): string[] {
  switch (source.kind) {
    case "reportGrid":
      return source.availableColumns ?? [];
    case "datasourceRows":
      return source.outputColumns;
    case "dataTableRow":
      return source.referencedElements;
    case "issueContext":
    case "worklogReport":
    case "dailyWorklogs":
    case "attendanceReport":
      return source.availableColumns;
    default:
      return [];
  }
}

/** What pms_lookup's filters/columns params accept for a given source. */
function lookupQueryCapabilities(source: PmsLookupSource): {
  filterableFields: unknown[];
  columns: string[];
} {
  const filterableFields =
    source.kind === "reportGrid"
      ? (source.filterableFields ?? []).map((field) => ({
          field: field.name,
          type: field.type,
          operators: field.type === "date" ? ["between"] : ["equals", "contains"],
          values: field.values ?? null,
        }))
      : [];
  return { filterableFields, columns: availableColumnsOf(source) };
}
