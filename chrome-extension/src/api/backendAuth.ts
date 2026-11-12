// The Donna backend accepts a request only with the user's live PMS access
// token; it asks PMS to confirm the token before doing anything.
import { PMS_ENVIRONMENT_HEADER } from "../../../shared/pms-api";
import { getPmsAccessToken } from "./pmsAuth";
import { getSelectedEnvironment, type PmsEnvironment } from "./pmsEnvironment";

export function backendAuthHeaders(
  token: string,
  environment: PmsEnvironment,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    [PMS_ENVIRONMENT_HEADER]: environment,
  };
}

/** Headers for calls that are not already bound to a PMS scope. */
export async function currentBackendAuthHeaders(
  environment?: PmsEnvironment,
): Promise<Record<string, string>> {
  environment ??= await getSelectedEnvironment();
  return backendAuthHeaders(await getPmsAccessToken(environment), environment);
}
