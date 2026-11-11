export interface StatusCondition {
  FieldName?: string; Operator?: string; Value?: unknown; ValueFieldName?: string;
  ConditionType?: string; ConditionConfiguration?: string; Conditions?: StatusCondition[];
}
interface Validation { ValidationType?: string; ValidationMessage?: string; IsDeleted?: boolean; RegularExpression?: string }
interface Action {
  FieldName?: string; Type?: string; Value?: unknown; ValueFieldName?: string;
  Validation?: Validation;
}
interface Block { Type: string; ConditionConfiguration?: string; Conditions: StatusCondition[]; Actions: Action[] }
export interface StatusRule { Name: string; Type: string; IsEnabled: boolean; RuleBlocks: Block[] }
export interface StatusElement {
  FieldName: string; LabelName: string; ElementType: string; IsHiddenField?: boolean;
  Hidden?: boolean; Disabled?: boolean; IsVisible?: boolean; DefaultValue?: unknown;
  LookUpType?: string; AppElementValidations?: Validation[];
  DataTableReference?: {
    DataTableId: string; DataTableFunctionId: string; ReferencedElements: string;
  };
}
export interface StatusForm {
  AppId: string; AppSections: { AppElements: StatusElement[] }[]; Rules: StatusRule[];
}

export const empty = (value: unknown): boolean => value === null || value === undefined ||
  (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);

function condition(condition: StatusCondition, values: Record<string, unknown>): boolean {
  if (condition.ConditionType === "Group") return conditions(condition.Conditions ?? [], undefined, values);
  const value = values[condition.FieldName ?? ""];
  const other = condition.ValueFieldName ? values[condition.ValueFieldName] : condition.Value;
  switch (condition.Operator) {
    case "Is Empty": return empty(value);
    case "Is Not Empty": return !empty(value);
    case "Is": return String(value ?? "") === String(other ?? "");
    case "Is Not": return String(value ?? "") !== String(other ?? "");
    case "Contains": return Array.isArray(value) ? value.includes(other) : String(value ?? "").includes(String(other));
    case "Contains Any": {
      const options = Array.isArray(other) ? other : String(other ?? "").split(",");
      return options.some(option => Array.isArray(value) ? value.includes(option) : String(value ?? "").includes(String(option)));
    }
    default: throw new Error(`Unsupported PMS condition: ${condition.Operator}. Use the PMS form.`);
  }
}

/** Parse Quixy's CONDITION-n expressions without evaluating server-provided code. */
function conditions(items: StatusCondition[], expression: string | undefined, values: Record<string, unknown>): boolean {
  if (!items.length) return false;
  const flatten = (entries: StatusCondition[]): StatusCondition[] => entries.flatMap(item =>
    item.ConditionType === "Group" ? flatten(item.Conditions ?? []) : [item]);
  // Quixy's explicit expressions number leaf conditions across nested groups.
  const results = (expression ? flatten(items) : items).map(item => condition(item, values));
  const text = expression || items.map((item, i) => `CONDITION-${i + 1}${i < items.length - 1 ? " " + (item.ConditionConfiguration || "AND") : ""}`).join(" ");
  const tokens = text.match(/CONDITION-\d+|AND|OR|\(|\)/g) ?? [];
  if (tokens.join("") !== text.replace(/\s/g, "")) throw new Error("Unsupported PMS condition expression.");
  let position = 0;
  const atom = (): boolean => {
    const token = tokens[position++];
    if (token === "(") { const value = or(); if (tokens[position++] !== ")") throw new Error("Invalid PMS condition group."); return value; }
    if (!token?.startsWith("CONDITION-")) throw new Error("Invalid PMS condition expression.");
    const index = Number(token.slice(10)) - 1;
    if (results[index] === undefined) throw new Error("Missing PMS condition.");
    return results[index];
  };
  const and = (): boolean => { let value = atom(); while (tokens[position] === "AND") { position++; const right = atom(); value = value && right; } return value; };
  const or = (): boolean => { let value = and(); while (tokens[position] === "OR") { position++; const right = and(); value = value || right; } return value; };
  const result = or();
  if (position !== tokens.length) throw new Error("Incomplete PMS condition expression.");
  return result;
}

function activeBlock(rule: StatusRule, values: Record<string, unknown>): Block | undefined {
  for (const block of rule.RuleBlocks) {
    if (block.Type === "ELSE" || conditions(block.Conditions, block.ConditionConfiguration, values)) return block;
    if (!["IF", "ELSEIF"].includes(block.Type)) throw new Error("Unsupported PMS rule block.");
  }
}

export function evaluateStatusForm(form: StatusForm, input: Record<string, unknown>) {
  const values = { ...input };
  const elements = form.AppSections.flatMap(section => section.AppElements);
  const byName = new Map(elements.map(element => [element.FieldName, element]));
  const visible = new Map(elements.map(element => [element.FieldName, !element.Hidden && !element.IsHiddenField && element.IsVisible !== false]));
  const disabled = new Set(elements.filter(element => element.Disabled).map(element => element.FieldName));
  const required = new Set<string>();
  const errors: { field: string; message: string }[] = [];
  for (const rule of form.Rules.filter(rule => rule.IsEnabled && rule.Type === "Field Rule")) {
    const block = activeBlock(rule, values);
    for (const action of block?.Actions ?? []) {
      const field = action.FieldName ?? "";
      switch (action.Type) {
        case undefined: case "": break;
        case "Show Element": visible.set(field, !byName.get(field)?.IsHiddenField); break;
        case "Hide Element": visible.set(field, false); break;
        case "Disable Element": disabled.add(field); break;
        case "Set Field Value": case "Set Value":
          // Reference fields are resolved by API, not by copying their display keys.
          if (byName.get(field)?.ElementType !== "DataTableReference") values[field] = action.ValueFieldName ? values[action.ValueFieldName] : action.Value;
          break;
        default: throw new Error(`Unsupported PMS field action: ${action.Type}. Use the PMS form.`);
      }
    }
  }
  for (const element of elements) {
    for (const validation of element.AppElementValidations ?? []) {
      if (validation.IsDeleted) continue;
      if (validation.ValidationType === "RequiredField") {
        if (visible.get(element.FieldName) && !disabled.has(element.FieldName)) {
          required.add(element.FieldName);
          if (empty(values[element.FieldName])) errors.push({ field: element.FieldName, message: validation.ValidationMessage || "Required" });
        }
      } else if (!empty(values[element.FieldName])) {
        if (validation.ValidationType === "Email" || validation.ValidationType === "PatternValidation") {
          if (!validation.RegularExpression || !new RegExp(validation.RegularExpression).test(String(values[element.FieldName]))) errors.push({ field: element.FieldName, message: validation.ValidationMessage || "Invalid value" });
        } else throw new Error(`Unsupported PMS field validation: ${validation.ValidationType}. Use the PMS form.`);
      }
    }
  }
  for (const rule of form.Rules.filter(rule => rule.IsEnabled && rule.Type !== "Field Rule")) {
    if (rule.Type !== "Validation") throw new Error(`Unsupported PMS rule type: ${rule.Type}.`);
    for (const action of activeBlock(rule, values)?.Actions ?? []) {
      const validation = action.Validation;
      if (!validation?.ValidationType || validation.IsDeleted) continue;
      const field = action.FieldName ?? "";
      if (validation.ValidationType === "RequiredField") {
        required.add(field);
        if (empty(values[field])) errors.push({ field, message: validation.ValidationMessage || rule.Name });
      } else if (validation.ValidationType === "CustomValidation") errors.push({ field, message: validation.ValidationMessage || rule.Name });
      else throw new Error(`Unsupported PMS submission validation: ${validation.ValidationType}.`);
    }
  }
  return { values, visible, required, errors, elements };
}
