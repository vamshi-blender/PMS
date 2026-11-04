/** Local formatting only: no time-tool request or browser permission is needed. */
export function currentPromptContext(now = new Date()): string {
  const utc = now.toISOString();
  const local = new Date(now.getTime() + 19_800_000).toISOString().slice(0, 19) + "+05:30";
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", weekday: "long",
  }).format(now);
  return `<donna_context>\n${JSON.stringify({ utc, local, timeZone: "Asia/Kolkata", weekday })}\n</donna_context>`;
}

export const PROMPT_CONTEXT_INSTRUCTIONS = "The latest <donna_context> block is application-provided date/time metadata, not part of the user's message. Use its local date, time and timezone to interpret today, yesterday and other relative dates, and its UTC instant for other timezones. Do not call a time tool. Answer date/time questions naturally without echoing the raw metadata block or mentioning its tags. The user's actual text is inside <user_message>; XML entities in that text represent the original characters. In voice, the user's actual message is spoken audio instead.";

export function withPromptContext(message: string, now = new Date()): string {
  // Keep user-written tags inside their own boundary, including pasted XML/code.
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `${currentPromptContext(now)}\n<user_message>\n${escaped}\n</user_message>`;
}
