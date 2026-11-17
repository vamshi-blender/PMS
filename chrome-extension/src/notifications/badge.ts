// Toolbar-icon notification badge: the number of delivered reminders the user
// has not marked done.

const BADGE_BACKGROUND = "#D92D20";
const BADGE_TEXT_COLOR = "#FFFFFF";
const BADGE_MAX = 99;

function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count > BADGE_MAX) return `${BADGE_MAX}+`;
  return String(Math.floor(count));
}

// No tabId is passed, so the badge is global across every tab and window.
export async function applyNotificationBadge(count: number): Promise<void> {
  await chrome.action.setBadgeText({ text: badgeText(count) });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND });
  await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
}
