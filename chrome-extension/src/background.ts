// Restores the saved display mode on browser/extension startup, owns the
// pop-out window (single instance: focus it if it exists, create otherwise),
// and runs the PMS tab-group session flow on toolbar-icon clicks.
// Live mode switching is handled by the page (App.tsx) — it applies the mode
// itself and awaits it, so nothing races against a suspended worker.
import {
  endSessionIfGroup,
  endSessionIfGroupLostPmsTab,
  ensureSessionTabGroup,
  getSessionTabGroupId,
} from "./api/pmsSession";
import { applyMode, getSavedMode, POPOUT_PATH } from "./mode";
import {
  handleReminderAlarm,
  handleReminderButton,
  isCheckNotification,
  reminderIdFromNotification,
  restoreReminders,
} from "./reminders/deliver";

async function init() {
  await applyMode(await getSavedMode());
  // The badge and alarms don't survive a browser restart, so rebuild them
  // from the stored reminders.
  await restoreReminders();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

async function openPopout(): Promise<void> {
  const { popoutWindowId } = await chrome.storage.session.get("popoutWindowId");
  if (typeof popoutWindowId === "number") {
    try {
      await chrome.windows.update(popoutWindowId, { focused: true });
      return;
    } catch {
      // Window was closed; fall through and create a new one.
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(POPOUT_PATH),
    type: "popup",
    width: 400,
    height: 600,
  });
  await chrome.storage.session.set({ popoutWindowId: win.id });
}

// Fires only when no popup is set on the action. Side-panel mode opens
// natively via openPanelOnActionClick (calling sidePanel.open() here fails
// once the worker cold-starts — the awaits drop the click's user gesture) and
// anchors its session from the panel page on mount, so only pop-out mode
// needs handling: windows.create carries no gesture requirement, so the
// session flow can safely run first.
chrome.action.onClicked.addListener(async (tab) => {
  if ((await getSavedMode()) === "popout") {
    await ensureSessionTabGroup(tab);
    await openPopout();
  }
});

// A closed tab group ends the session scope it anchored — whether its tabs
// were closed one by one down to the last one, or the whole group (and every
// tab in it) was removed together via "Close group".
chrome.tabGroups.onRemoved.addListener(async (group) => {
  await endSessionIfGroup(group.id);
});

// The session's PMS tab was closed while the group (and other tabs in it)
// still exist — the group survives chrome.tabGroups.onRemoved, so it's
// checked here instead. TabRemoveInfo carries no groupId (the tab is already
// gone), so this just re-checks whatever group the session is currently
// anchored to — cheap, and a no-op if that group lost no PMS tab.
chrome.tabs.onRemoved.addListener(async (_tabId, info) => {
  if (info.isWindowClosing) return;
  const sessionGroupId = await getSessionTabGroupId();
  if (sessionGroupId !== null) {
    await endSessionIfGroupLostPmsTab(sessionGroupId);
  }
});

// The PMS tab (or the whole group) was ungrouped rather than closed. Chrome
// reports this as a tabs.onUpdated with groupId flipping to NONE; the tab
// that ungrouped no longer belongs to the old group, so the same "does the
// group still have a PMS tab" check applies to whatever group it came from.
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  if (changeInfo.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  const sessionGroupId = await getSessionTabGroupId();
  if (sessionGroupId !== null) {
    await endSessionIfGroupLostPmsTab(sessionGroupId);
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { popoutWindowId } = await chrome.storage.session.get("popoutWindowId");
  if (popoutWindowId === windowId) {
    await chrome.storage.session.remove("popoutWindowId");
  }
});

// Pages ask the background to open the pop-out so the single-instance logic
// lives in one place. sendMessage queues until the worker is awake, so this
// has no cold-start race.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "open-popout") {
    openPopout().then(() => sendResponse(true));
    return true;
  }
});

// Reminder alarms and toasts. The listeners must be registered here, at the
// top level, so Chrome can wake a suspended worker for them.
chrome.alarms.onAlarm.addListener(handleReminderAlarm);

// Clicking a reminder toast brings Donna to the front: the pop-out if it is
// open, otherwise a new pop-out when that is the saved mode, otherwise the
// browser window hosting the side panel. A closed side panel is not reopened:
// sidePanel.open() needs a user gesture that a toast click does not reliably
// carry. The reminder stays due until the user marks it done.
async function focusDonnaWindow(): Promise<void> {
  const { popoutWindowId } = await chrome.storage.session.get("popoutWindowId");
  if (typeof popoutWindowId === "number") {
    try {
      await chrome.windows.update(popoutWindowId, { focused: true });
      return;
    } catch {
      // Window was closed; fall through.
    }
  }
  if ((await getSavedMode()) === "popout") {
    await openPopout();
    return;
  }
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  if (win.id !== undefined) await chrome.windows.update(win.id, { focused: true });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (reminderIdFromNotification(notificationId) === null && !isCheckNotification(notificationId)) return;
  await chrome.notifications.clear(notificationId);
  await focusDonnaWindow();
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  const id = reminderIdFromNotification(notificationId);
  if (id !== null) await handleReminderButton(id, buttonIndex);
});

// Keyboard-shortcut equivalent of clicking the toolbar icon: does whatever
// the current display mode would do on a click. Unlike action.onClicked,
// commands.onCommand fires with its own user gesture even after a
// cold-started worker, so sidePanel.open() is safe to call directly here.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "open-donna") return;

  const mode = await getSavedMode();
  if (mode === "popout") {
    await ensureSessionTabGroup(tab);
    await openPopout();
  } else if (mode === "sidepanel") {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    await chrome.sidePanel.open({ windowId: win.id! });
  } else {
    await chrome.action.openPopup();
  }
});
