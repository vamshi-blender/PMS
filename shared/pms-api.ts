// PMS API origins, shared by the extension (which calls PMS as the user) and
// the backend (which asks PMS to confirm who a caller is).
export const PMS_API_URLS = {
  staging: "https://quixyhomeapi.kwixee.co.in",
  production: "https://homeapi.quixy.com",
} as const;

// Tells the backend which PMS environment issued the caller's access token.
export const PMS_ENVIRONMENT_HEADER = "X-Pms-Environment";
