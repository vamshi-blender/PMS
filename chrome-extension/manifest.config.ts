import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "Donna",
  // Single source of truth: bump "version" in package.json only. Chrome allows
  // digits and dots only (e.g. 1.2.0), so no -beta style suffixes.
  version: pkg.version,
  description:
    "Donna opens in a floating pop-out window, with optional popup and side-panel modes.",
  // "tabs" gives reliable tab.url on every scheme for PMS matching; "tabGroups"
  // covers tabGroups.get/update/onRemoved for the session tab-group scope.
  permissions: [
    "activeTab",
    "scripting",
    "sidePanel",
    "storage",
    "tabGroups",
    "tabs",
  ],
  // SECURITY: broadened from localhost-only host_permissions (plus
  // optional_host_permissions with per-URL runtime grants) to all http/https
  // sites, so the extension works on every page and backend without prompts.
  // Dev-phase decision; see this commit to restore the narrow grants.
  host_permissions: ["http://*/*", "https://*/*"],
  icons: {
    16: "public/icons/icon16.png",
    32: "public/icons/icon32.png",
    48: "public/icons/icon48.png",
    128: "public/icons/icon128.png",
  },
  action: {
    default_title: "Donna",
    default_icon: {
      16: "public/icons/icon16.png",
      32: "public/icons/icon32.png",
    },
  },
  side_panel: {
    default_path: "src/sidepanel.html",
  },
  commands: {
    "open-donna": {
      suggested_key: {
        default: "Ctrl+Shift+Y",
      },
      description: "Open Donna",
    },
  },
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
});
