import pino from "pino";
import type { SentinelConfig } from "./config.js";
import type { Verdict } from "./classifier.js";
import { sendToSelf } from "./whatsapp.js";
import type { IncomingMessage } from "./whatsapp.js";

const logger = pino({ level: "info" });

const TAGS: Record<Verdict["category"], string> = {
  scam: "warning",
  opportunity: "gift",
  deadline: "alarm_clock",
  event: "calendar",
  job: "briefcase",
  announcement: "mega",
  question_for_you: "question",
  other: "bell",
};

function priorityFor(v: Verdict): string {
  switch (v.urgency) {
    case "now":
      return "5";
    case "today":
      return "4";
    default:
      return "3";
  }
}

async function notifyNtfy(
  verdict: Verdict,
  msg: IncomingMessage,
  cfg: SentinelConfig,
): Promise<void> {
  const topic = cfg.notify.ntfyTopic?.trim();
  if (!topic) return;
  const server = (cfg.notify.ntfyServer || "https://ntfy.sh").replace(/\/$/, "");
  const headers: Record<string, string> = {
    Title: `[${msg.groupName}] ${verdict.title}`,
    Priority: priorityFor(verdict),
    Tags: TAGS[verdict.category],
  };
  if (verdict.links.length > 0) headers.Click = verdict.links[0];
  const token = (process.env.NTFY_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const body =
    `${verdict.summary}\n— ${msg.sender} in ${msg.groupName}` +
    (verdict.links.length ? `\n${verdict.links.join("\n")}` : "");
  const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers,
    body,
  });
  if (!res.ok) {
    throw new Error(`ntfy returned ${res.status}`);
  }
}

async function notifySelfChat(
  verdict: Verdict,
  msg: IncomingMessage,
  cfg: SentinelConfig,
): Promise<void> {
  if (!cfg.notify.selfChat) return;
  const isScam = verdict.category === "scam";
  const lines = [
    `${isScam ? "⚠️" : "🔔"} *${verdict.title}*`,
    isScam
      ? `Possible scam — do not click/pay.\n${verdict.summary}`
      : verdict.summary,
  ];
  if (verdict.deadline) lines.push(`⏰ ${verdict.deadline}`);
  lines.push(`👤 ${msg.sender} · ${msg.groupName}`);
  if (verdict.links.length) lines.push(verdict.links.join("\n"));
  await sendToSelf(lines.join("\n"));
}

export async function notify(
  verdict: Verdict,
  msg: IncomingMessage,
  cfg: SentinelConfig,
): Promise<void> {
  try {
    await notifyNtfy(verdict, msg, cfg);
  } catch (e) {
    logger.warn({ e }, "ntfy notification failed");
  }
  try {
    await notifySelfChat(verdict, msg, cfg);
  } catch (e) {
    logger.warn({ e }, "self-chat notification failed");
  }
}
