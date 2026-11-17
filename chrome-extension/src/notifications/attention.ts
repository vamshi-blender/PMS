// Flashes this window's taskbar button (Windows) without stealing focus, the
// way Teams does on a new message.

export async function drawAttentionToCurrentWindow(): Promise<void> {
  const win = await chrome.windows.getCurrent();
  // Chrome ignores drawAttention on a focused window, so skip the call and
  // keep the intent obvious.
  if (win.id === undefined || win.focused) return;
  await chrome.windows.update(win.id, { drawAttention: true });
}

/**
 * The service worker delivers reminders and announces each one; an open
 * Donna window just blinks. Returns a function that stops listening.
 */
export function blinkOnReminderFired(): () => void {
  const handleMessage = (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type !== "reminder-fired") return;
    void drawAttentionToCurrentWindow().catch((error) => {
      console.warn("Reminder: drawAttention failed", error);
    });
  };
  chrome.runtime.onMessage.addListener(handleMessage);
  return () => chrome.runtime.onMessage.removeListener(handleMessage);
}
