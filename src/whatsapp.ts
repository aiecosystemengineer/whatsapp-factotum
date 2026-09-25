import fs from "node:fs";
import path from "node:path";
import qrcode from "qrcode-terminal";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import { rateLimit, sanitizePlainText } from "./security.js";

export type IncomingMessage = {
  id: string;
  groupId: string;
  groupName: string;
  sender: string;
  text: string;
  timestamp: string;
};

const AUTH_DIR = path.join(process.cwd(), "auth");
const logger = pino({ level: "info" });
const silentLogger = pino({ level: "silent" });

let sock: WASocket | null = null;
let selfJid: string | null = null;
let ready = false;
const groupNameCache = new Map<string, string>();
const readyWaiters: Array<() => void> = [];

function textFromMessage(message: proto.IMessage | undefined | null): string {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

async function resolveGroupName(jid: string): Promise<string> {
  const cached = groupNameCache.get(jid);
  if (cached) return cached;
  let name = "Group";
  try {
    const meta = await sock?.groupMetadata(jid);
    if (meta?.subject) name = meta.subject;
  } catch {
    /* keep fallback */
  }
  groupNameCache.set(jid, name);
  return name;
}

export type ConnectOpts = {
  onMessage?: (msg: IncomingMessage) => void;
  onReady?: () => void;
};

export async function connect(opts: ConnectOpts = {}): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: silentLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      logger.info("Scan this QR in WhatsApp › Linked devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      ready = true;
      selfJid = sock?.user?.id || null;
      logger.info({ selfJid }, "WhatsApp linked");
      for (const w of readyWaiters.splice(0)) w();
      opts.onReady?.();
    }
    if (connection === "close") {
      const code = (
        lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      ready = false;
      selfJid = null;
      logger.warn({ code }, "connection closed");
      if (loggedOut) {
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
          logger.info("cleared auth after logout — new QR will be shown");
        } catch (e) {
          logger.warn({ e }, "failed to clear auth");
        }
      }
      setTimeout(() => void connect(opts), loggedOut ? 800 : 2000);
    }
  });

  sock.ev.on("groups.update", (updates) => {
    for (const g of updates) {
      if (g.id && g.subject) groupNameCache.set(g.id, g.subject);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (!jid || !jid.endsWith("@g.us")) continue;
        if (m.key.fromMe) continue;
        const text = textFromMessage(m.message);
        if (!text.trim()) continue;
        const groupName = await resolveGroupName(jid);
        const sender =
          m.pushName ||
          (m.key.participant || "").split("@")[0] ||
          "Unknown";
        opts.onMessage?.({
          id: m.key.id || `${Date.now()}`,
          groupId: jid,
          groupName,
          sender,
          text,
          timestamp: new Date(
            Number(m.messageTimestamp) * 1000 || Date.now(),
          ).toISOString(),
        });
      } catch (e) {
        logger.warn({ e }, "failed to handle incoming message");
      }
    }
  });
}

export function waitUntilReady(timeoutMs = 120_000): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WhatsApp connection")),
      timeoutMs,
    );
    readyWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function listGroups(): Promise<
  { id: string; name: string; memberCount: number }[]
> {
  const groups = await sock!.groupFetchAllParticipating();
  return Object.values(groups || {})
    .map((g) => {
      const name = (g.subject || "").trim() || "Group";
      if (g.id) groupNameCache.set(g.id, name);
      return {
        id: g.id,
        name,
        memberCount:
          typeof g.size === "number" && g.size > 0
            ? g.size
            : (g.participants?.length ?? 0),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Only ever sends to the user's own chat. Rate-limited to 20/min. */
export async function sendToSelf(text: string): Promise<void> {
  if (!sock || !ready || !selfJid) {
    throw new Error("WhatsApp not linked");
  }
  const bare = selfJid.replace(/:\d+@/, "@");
  if (bare.includes("@g.us") || bare.includes("@broadcast")) {
    throw new Error("Refusing non-self destination");
  }
  const clean = sanitizePlainText(text, 3500);
  if (!clean) return;
  const rl = rateLimit("self-chat", 20, 60_000);
  if (!rl.ok) {
    logger.warn({ retryAfterMs: rl.retryAfterMs }, "self-chat rate limit hit");
    return;
  }
  await sock.sendMessage(bare, { text: clean });
}
