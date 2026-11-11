import { toolArgumentsHash } from "./pms-scope";

/** Ignore presentation and per-user permissions; fingerprint the form's
 * identity, field types, references, validations and complete business rules. */
export async function pmsFormHash(form: Record<string, unknown>): Promise<string> {
  const sections = form.AppSections as { AppElements: Record<string, unknown>[] }[];
  if (!Array.isArray(sections) || sections.some(section => !Array.isArray(section.AppElements)) || !Array.isArray(form.Rules)) {
    throw new Error("PMS returned an invalid form definition.");
  }
  const keys = ["FieldName", "ElementType", "LookUpType", "DataTableReference", "DataSourceReference", "CalendarId",
    "Hidden", "IsHiddenField", "IsVisible", "Disabled", "AppElementValidations", "FormulaQuery", "DefaultValue", "ReferenceName", "ReferenceId"];
  const elementShape = (element: Record<string, unknown>): Record<string, unknown> => {
    const result = Object.fromEntries(keys.filter(key => element[key] !== undefined).map(key => [key, element[key]]));
    const child = element.App as Record<string, unknown> | undefined;
    if (Array.isArray(child?.AppSections)) {
      result.App = { elements: (child.AppSections as { AppElements: Record<string, unknown>[] }[])
        .flatMap(section => section.AppElements).map(elementShape), Rules: child.Rules ?? [] };
    }
    return result;
  };
  return toolArgumentsHash("pms_form", {
    AppId: form.AppId, OrganizationId: form.OrganizationId, WorkSpaceId: form.WorkSpaceId,
    elements: sections.flatMap(section => section.AppElements).map(elementShape),
    Rules: form.Rules,
    Workflow: form.Workflow,
  });
}
