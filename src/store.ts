import fs from "node:fs";
import path from "node:path";
import type { Verdict } from "./classifier.js";
import type { IncomingMessage } from "./whatsapp.js";

const DATA_DIR = path.join(process.cwd(), "data");
const SEEN_FILE = path.join(DATA_DIR, "seen.json");
const RECENT_FILE = path.join(DATA_DIR, "recent.json");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");

const MAX_SEEN = 5000;
const MAX_RECENT_PER_GROUP = 50;
const MAX_ALERTS = 2000;

export type AlertRecord = {
  verdict: Verdict;
  message: IncomingMessage;
  sentAt: string;
};

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function saveJson(file: string, data: unknown) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- seen message ids ---

let seenCache: string[] | null = null;

function loadSeen(): string[] {
  if (!seenCache) seenCache = loadJson<string[]>(SEEN_FILE, []);
  return seenCache;
}

export function hasSeen(id: string): boolean {
  return loadSeen().includes(id);
}

export function markSeen(id: string): void {
  const seen = loadSeen();
  seen.push(id);
  if (seen.length > MAX_SEEN) seen.splice(0, seen.length - MAX_SEEN);
  saveJson(SEEN_FILE, seen);
}

// --- recent messages per group (LLM context) ---

export function pushRecent(msg: IncomingMessage): void {
  const recent = loadJson<Record<string, IncomingMessage[]>>(RECENT_FILE, {});
  const list = recent[msg.groupId] || [];
  list.push(msg);
  recent[msg.groupId] = list.slice(-MAX_RECENT_PER_GROUP);
  saveJson(RECENT_FILE, recent);
}

export function recentFor(groupId: string, n = 10): IncomingMessage[] {
  const recent = loadJson<Record<string, IncomingMessage[]>>(RECENT_FILE, {});
  return (recent[groupId] || []).slice(-n);
}

// --- alerts ---

export function appendAlert(record: AlertRecord): void {
  const alerts = loadJson<AlertRecord[]>(ALERTS_FILE, []);
  alerts.push(record);
  saveJson(ALERTS_FILE, alerts.slice(-MAX_ALERTS));
}

export function alertsSince(sinceIso: string): AlertRecord[] {
  const alerts = loadJson<AlertRecord[]>(ALERTS_FILE, []);
  return alerts.filter((a) => a.sentAt >= sinceIso);
}
