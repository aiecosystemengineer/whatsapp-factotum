import pino from "pino";
import { classifyBatch, type Verdict } from "./classifier.js";
import type { SentinelConfig } from "./config.js";
import { notify } from "./notifier.js";
import {
  appendAlert,
  alertsSince,
  hasSeen,
  markSeen,
  pushRecent,
  recentFor,
} from "./store.js";
import {
  connect,
  sendToSelf,
  type IncomingMessage,
} from "./whatsapp.js";

const logger = pino({ level: "info" });

const buffers = new Map<string, IncomingMessage[]>();
const timers = new Map<string, NodeJS.Timeout>();
let ignoredToday = 0;
let ignoredDay = new Date().toDateString();
let digestSentFor = "";

async function flushGroup(groupId: string, cfg: SentinelConfig): Promise<void> {
  const batch = buffers.get(groupId) || [];
  buffers.set(groupId, []);
  if (batch.length === 0) return;
  const context = recentFor(groupId, 10).filter(
    (c) => !batch.some((m) => m.id === c.id),
  );
  let verdicts: Verdict[];
  try {
    verdicts = await classifyBatch(batch, context, cfg);
  } catch (e) {
    logger.error({ e }, "classification failed");
    return;
  }
  const byId = new Map(batch.map((m) => [m.id, m]));
  for (const v of verdicts) {
    const msg = byId.get(v.messageId);
    logger.info(
      {
        score: v.score,
        category: v.category,
        notify: v.notify,
        title: v.title,
        groupId,
      },
      "verdict",
    );
    if (v.notify && msg) {
      await notify(v, msg, cfg);
      appendAlert({ verdict: v, message: msg, sentAt: new Date().toISOString() });
    } else {
      ignoredToday += 1;
    }
  }
}

export function buildDigestText(): string {
  const today = new Date().toDateString();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const alerts = alertsSince(startOfDay.toISOString());
  const lines: string[] = ["📋 *WhatsApp Sentinel — daily digest*"];
  if (alerts.length === 0) {
    lines.push("All quiet today — nothing worth interrupting you for.");
  } else {
    const byGroup = new Map<string, typeof alerts>();
    for (const a of alerts) {
      const g = a.message.groupName;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(a);
    }
    for (const [group, list] of byGroup) {
      lines.push(`\n*${group}*`);
      for (const a of list) {
        const icon = a.verdict.category === "scam" ? "⚠️" : "🔔";
        lines.push(`${icon} ${a.verdict.title} (score ${a.verdict.score})`);
        if (a.verdict.links.length) {
          lines.push(`   ${a.verdict.links[0]}`);
        }
      }
    }
    lines.push(`\n${alerts.length} alert${alerts.length === 1 ? "" : "s"} today.`);
  }
  if (ignoredDay === today && ignoredToday > 0) {
    lines.push(`(${ignoredToday} other messages were checked and ignored.)`);
  }
  return lines.join("\n");
}

export async function sendDigest(): Promise<void> {
  await sendToSelf(buildDigestText());
}

export async function startWatcher(cfg: SentinelConfig): Promise<void> {
  const watched = new Set(cfg.watchedGroups.map((g) => g.id));
  if (watched.size === 0) {
    logger.warn(
      "watchedGroups is empty — nothing to watch. Run `npm run groups` and paste JIDs into sentinel.config.json.",
    );
  }

  await connect({
    onMessage(msg) {
      if (!watched.has(msg.groupId)) return;
      if (hasSeen(msg.id)) return;
      markSeen(msg.id);
      pushRecent(msg);
      const buf = buffers.get(msg.groupId) || [];
      buf.push(msg);
      buffers.set(msg.groupId, buf);
      const existing = timers.get(msg.groupId);
      if (existing) clearTimeout(existing);
      timers.set(
        msg.groupId,
        setTimeout(
          () => void flushGroup(msg.groupId, cfg),
          cfg.batchWindowSeconds * 1000,
        ),
      );
    },
    onReady() {
      logger.info(
        { groups: watched.size, minScore: cfg.minScore },
        "Sentinel watching",
      );
    },
  });

  // Daily digest check (fires once per day at configured local hour)
  const digestTimer = setInterval(() => {
    if (!cfg.digest.enabled) return;
    const now = new Date();
    if (now.toDateString() !== ignoredDay) {
      ignoredDay = now.toDateString();
      ignoredToday = 0;
    }
    const key = `${now.toDateString()}`;
    if (now.getHours() === cfg.digest.hour && digestSentFor !== key) {
      digestSentFor = key;
      void sendDigest().catch((e) =>
        logger.warn({ e }, "daily digest send failed"),
      );
    }
  }, 60_000);
  digestTimer.unref?.();

  process.on("SIGINT", () => {
    logger.info("Shutting down…");
    for (const t of timers.values()) clearTimeout(t);
    clearInterval(digestTimer);
    process.exit(0);
  });
}
