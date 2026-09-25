import pino from "pino";
import { classifyBatch, classifyHeuristic } from "./classifier.js";
import {
  defaultConfig,
  loadConfig,
  type SentinelConfig,
} from "./config.js";
import { notify } from "./notifier.js";
import { connect, listGroups, waitUntilReady } from "./whatsapp.js";
import type { IncomingMessage } from "./whatsapp.js";
import { sendDigest, startWatcher } from "./watcher.js";

const logger = pino({
  level: "info",
  transport: { target: "pino-pretty", options: { colorize: true } },
});

const USAGE = `WhatsApp Sentinel — watches your group chats and pings you about what matters.

Usage:
  npm run link                    Link WhatsApp (scan QR via Linked devices)
  npm run groups                  List your group JIDs to paste into sentinel.config.json
  npm run watch                   Start watching
  npm run test -- "<text>" [--llm] [--send]   Classify a test message
  npm run digest                  Send today's digest now
`;

function mustConfig(): SentinelConfig {
  try {
    return loadConfig();
  } catch (e) {
    logger.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case "link": {
      await connect({
        onReady() {
          waitUntilReady()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
        },
      });
      await waitUntilReady();
      logger.info("Linked — auth saved in ./auth");
      process.exit(0);
    }

    case "groups": {
      await connect();
      await waitUntilReady();
      const groups = await listGroups();
      if (groups.length === 0) {
        logger.info("No groups found.");
      } else {
        console.log("\nJID                                |  name                          |  members");
        console.log("-".repeat(90));
        for (const g of groups) {
          console.log(
            `${g.id.padEnd(34)} |  ${g.name.slice(0, 30).padEnd(30)} |  ${g.memberCount}`,
          );
        }
      }
      console.log(
        "\nPaste the JIDs you want to watch into sentinel.config.json → watchedGroups.",
      );
      process.exit(0);
    }

    case "watch": {
      const cfg = mustConfig();
      await startWatcher(cfg);
      break; // runs forever
    }

    case "test": {
      const args = process.argv.slice(3);
      const useLlm = args.includes("--llm");
      const send = args.includes("--send");
      const text = args.filter((a) => !a.startsWith("--")).join(" ").trim();
      if (!text) {
        console.error('Usage: npm run test -- "<message text>" [--llm] [--send]');
        process.exit(1);
      }
      let cfg: SentinelConfig;
      try {
        cfg = loadConfig();
      } catch {
        logger.warn(
          "No sentinel.config.json — using defaults for this test run",
        );
        cfg = defaultConfig();
      }
      const msg: IncomingMessage = {
        id: `test-${Date.now()}`,
        groupId: "test@g.us",
        groupName: "Test group",
        sender: "Tester",
        text,
        timestamp: new Date().toISOString(),
      };
      const verdicts = useLlm
        ? await classifyBatch([msg], [], cfg)
        : classifyHeuristic([msg], cfg);
      console.log(JSON.stringify(verdicts, null, 2));
      if (send) {
        for (const v of verdicts.filter((v) => v.notify)) {
          await notify(v, msg, cfg);
        }
      }
      process.exit(0);
    }

    case "digest": {
      mustConfig();
      await connect();
      await waitUntilReady();
      await sendDigest();
      logger.info("Digest sent to self-chat");
      process.exit(0);
    }

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  logger.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
