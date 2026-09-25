import { describe, expect, it } from "vitest";
import {
  classifyHeuristic,
  postProcess,
  type Verdict,
} from "../src/classifier.js";
import type { SentinelConfig } from "../src/config.js";
import type { IncomingMessage } from "../src/whatsapp.js";

const cfg: SentinelConfig = {
  watchedGroups: [],
  interests: ["free AI credits and vouchers", "hackathons"],
  ignoreKeywords: [],
  minScore: 60,
  batchWindowSeconds: 20,
  notify: { ntfyServer: "https://ntfy.sh", selfChat: true },
  llm: { provider: "none" },
  digest: { enabled: true, hour: 21 },
};

function msg(text: string, id = "m1"): IncomingMessage {
  return {
    id,
    groupId: "g@g.us",
    groupName: "Test",
    sender: "Alice",
    text,
    timestamp: new Date().toISOString(),
  };
}

describe("classifyHeuristic", () => {
  it("flags a free-credits opportunity with its link", () => {
    const m = msg(
      "Guys, Anthropic is giving $250 free Claude credits for builders, claim before Friday: https://claude.ai/credits",
    );
    const [v] = classifyHeuristic([m], cfg);
    expect(v.notify).toBe(true);
    expect(v.category).toBe("opportunity");
    expect(v.score).toBeGreaterThanOrEqual(78);
    expect(v.links).toContain("https://claude.ai/credits");
  });

  it("ignores trivial chatter", () => {
    const [v] = classifyHeuristic([msg("haha ok thanks")], cfg);
    expect(v.notify).toBe(false);
    expect(v.score).toBe(0);
  });

  it("flags scams regardless of minScore", () => {
    const [v] = classifyHeuristic(
      [msg("URGENT: your account is locked, send OTP to +60123456789 now")],
      { ...cfg, minScore: 95 },
    );
    expect(v.category).toBe("scam");
    expect(v.notify).toBe(true);
  });

  it("flags a registration closing tomorrow", () => {
    const [v] = classifyHeuristic(
      [msg("Reminder: hackathon registration closes tomorrow lu.ma/xyz")],
      cfg,
    );
    expect(v.notify).toBe(true);
    expect(["deadline", "event"]).toContain(v.category);
    expect(["now", "today"]).toContain(v.urgency);
  });

  it("drops messages matching ignoreKeywords", () => {
    const [v] = classifyHeuristic(
      [msg("free crypto airdrop, claim your voucher now https://x.co/1")],
      { ...cfg, ignoreKeywords: ["crypto"] },
    );
    expect(v).toBeUndefined();
  });
});

describe("postProcess", () => {
  it("filters links not present in the message text and applies minScore", () => {
    const m = msg("claim your free credits here https://real.link/x");
    const fakeVerdict: Verdict = {
      messageId: m.id,
      notify: false,
      score: 50, // below minScore 60
      category: "opportunity",
      urgency: "this_week",
      title: "t",
      summary: "s",
      links: ["https://real.link/x", "https://invented.example.com"],
    };
    const [v] = postProcess([fakeVerdict], [m], cfg);
    expect(v.notify).toBe(false);
    expect(v.links).toEqual(["https://real.link/x"]);

    const [v2] = postProcess(
      [{ ...fakeVerdict, score: 80 }],
      [m],
      cfg,
    );
    expect(v2.notify).toBe(true);
  });
});
