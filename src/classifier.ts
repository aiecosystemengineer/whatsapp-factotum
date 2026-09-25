import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import pino from "pino";
import { z } from "zod";
import {
  apiKeyForProvider,
  type LlmProvider,
  type FactotumConfig,
} from "./config.js";
import {
  AGENT_SECURITY_PREAMBLE,
  buildUntrustedDataBlock,
  redactSecrets,
  sanitizeIncomingMessages,
} from "./security.js";
import type { IncomingMessage } from "./whatsapp.js";

const logger = pino({ level: "info" });

export type Verdict = {
  messageId: string;
  notify: boolean;
  score: number;
  category:
    | "opportunity"
    | "deadline"
    | "event"
    | "job"
    | "announcement"
    | "question_for_you"
    | "scam"
    | "other";
  urgency: "now" | "today" | "this_week" | "none";
  title: string;
  summary: string;
  deadline?: string;
  links: string[];
};

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      messageId: z.string(),
      score: z.number().min(0).max(100),
      category: z.enum([
        "opportunity",
        "deadline",
        "event",
        "job",
        "announcement",
        "question_for_you",
        "scam",
        "other",
      ]),
      urgency: z.enum(["now", "today", "this_week", "none"]),
      title: z.string(),
      summary: z.string(),
      deadline: z.string().optional(),
      links: z.array(z.string()).default([]),
    }),
  ),
});

const PROMPT = `${AGENT_SECURITY_PREAMBLE}

You are WhatsApp Factotum, a personal assistant that watches busy WhatsApp group chats for ONE user and decides which messages they must not miss.

The user's interests (plain language):
{{interests}}

For EACH message in the "messages" list of the untrusted block, return one verdict (same messageId). Notify when the message is:
- A time-limited or limited-quantity opportunity anyone in the group can act on: free credits, vouchers, promo codes, giveaways, grants, free tickets, early access, beta invites, discounts (e.g. "$250 free Claude credits, claim before Friday").
- A deadline, registration, RSVP, form or sign-up that closes soon.
- An event, meetup, workshop or hackathon with a link or limited seats.
- A job, gig, collaboration or funding opportunity matching the interests.
- An important announcement from an admin/organiser that changes plans (venue, time, cancellation).
- A question or request that appears to be directed at the user.
- A likely scam (OTP, PIN, bank transfer to a stranger, too-good-to-be-true with a suspicious link) — use category "scam" so the user is warned, not tempted.
Do NOT notify for: greetings, thanks, emojis, jokes, small talk, general news links without an action, forwarded motivational text, or replies that add nothing new.

Scoring: 0-100 importance for THIS user. 80+ = must act now (limited quantity, closing within 24h, or high value). 60-79 = worth acting today or this week. 40-59 = nice to know. Below 40 = ignore. The user is notified at {{minScore}} and above.
Use the "context" messages (earlier messages in the same group) only to understand the new messages, e.g. a link posted right after "free credits here:". Do not return verdicts for context messages.
Write title (max 60 chars) and summary (max 200 chars) in plain, direct language stating the concrete action and any deadline. Copy any URL exactly as written; never invent links, amounts or dates.

{{untrusted_block}}`;

function getModel(provider: LlmProvider, model: string | undefined, apiKey: string) {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(model || "claude-haiku-4-5");
    case "google":
      return createGoogleGenerativeAI({ apiKey })(model || "gemini-2.0-flash");
    case "openrouter":
      return createOpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
      })(model || "openai/gpt-4o-mini");
    case "openai":
    default:
      return createOpenAI({ apiKey })(model || "gpt-4o-mini");
  }
}

const URL_RE = /https?:\/\/[^\s)]+/gi;

export function extractLinks(text: string): string[] {
  return Array.from(text.matchAll(URL_RE)).map((m) => m[0]);
}

function isTrivialMessage(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 12) return true;
  if (
    /^(ok|okay|ready|yes|no|ya|yup|hmm+|lol|haha|👍|🙏|ok+e?|noted|kk|tq|thanks|thank you)\.?$/i.test(
      t,
    )
  )
    return true;
  if (t.split(/\s+/).length <= 2 && !/https?:\/\//i.test(t) && !/\d/.test(t))
    return true;
  return false;
}

function matchesIgnore(text: string, cfg: FactotumConfig): boolean {
  const lower = text.toLowerCase();
  return cfg.ignoreKeywords.some((k) => k && lower.includes(k.toLowerCase()));
}

function interestHit(text: string, cfg: FactotumConfig): boolean {
  const lower = text.toLowerCase();
  const words = new Set<string>();
  for (const interest of cfg.interests) {
    for (const w of interest.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 4) words.add(w);
    }
  }
  for (const w of words) {
    if (lower.includes(w)) return true;
  }
  return false;
}

function urgencyFor(score: number): Verdict["urgency"] {
  if (score >= 80) return "now";
  if (score >= 65) return "today";
  if (score >= 50) return "this_week";
  return "none";
}

const HEURISTIC_RULES: Array<{
  category: Verdict["category"];
  score: number;
  re: RegExp;
}> = [
  {
    category: "opportunity",
    score: 78,
    re: /free (credits?|tokens?|tickets?|access|trial|month|pass)|credits? (to|for) (claim|redeem)|claim (your|the|before)|redeem|voucher|promo ?code|coupon|giveaway|discount|early access|beta invite|grant|scholarship|\$\s?\d+ ?(free|credits?)|rm ?\d+ ?(free|off)/,
  },
  {
    category: "deadline",
    score: 72,
    re: /deadline|closes? (today|tomorrow|tonight|soon|on)|last (day|call|chance)|by (today|tomorrow|tonight|midnight|\d{1,2}(am|pm)|mon|tue|wed|thu|fri|sat|sun)|before (today|tomorrow|midnight)|expires?|ends? (today|tomorrow|tonight)|limited (slots?|seats?|spots?)|only \d+ (left|slots?|seats?)/,
  },
  {
    category: "event",
    score: 65,
    re: /lu\.ma|luma\.|eventbrite|meetup|workshop|hackathon|webinar|conference|register|registration|rsvp|sign ?up|seats?/,
  },
  {
    category: "job",
    score: 62,
    re: /hiring|we're looking for|looking for (a|an) .*(dev|engineer|designer)|job|vacancy|internship|freelance|gig|bounty|collab/,
  },
  {
    category: "announcement",
    score: 60,
    re: /announcement|important|attention all|reminder|venue|postponed|cancel+ed|reschedul|change of/,
  },
  {
    category: "question_for_you",
    score: 55,
    re: /anyone|can someone|does anyone|who can|need help|pls reply|please reply|\?$/,
  },
  {
    category: "scam",
    score: 70,
    re: /otp|atm pin|bank pin|ic number|transfer .*(first|deposit)|processing fee|bit\.ly|tinyurl|\.xyz\b|you have been selected|congratulations you won/,
  },
];

export function classifyHeuristic(
  messages: IncomingMessage[],
  cfg: FactotumConfig,
): Verdict[] {
  const verdicts: Verdict[] = [];
  for (const m of messages) {
    const links = extractLinks(m.text);
    const base: Verdict = {
      messageId: m.id,
      notify: false,
      score: 0,
      category: "other",
      urgency: "none",
      title: "",
      summary: "",
      links,
    };
    if (isTrivialMessage(m.text)) {
      verdicts.push(base);
      continue;
    }
    const lower = m.text.toLowerCase();
    let best = base;
    for (const rule of HEURISTIC_RULES) {
      if (rule.re.test(lower) && rule.score > best.score) {
        best = { ...best, category: rule.category, score: rule.score };
      }
    }
    let score = best.score;
    if (score > 0) {
      if (links.length > 0) score += 10;
      if (/today|tomorrow|tonight|urgent|hurry|fast/.test(lower)) score += 5;
      if (interestHit(m.text, cfg)) score += 8;
      score = Math.min(100, score);
    }
    const title = m.text
      .replace(URL_RE, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    verdicts.push({
      ...best,
      score,
      urgency: urgencyFor(score),
      title,
      summary: m.text.slice(0, 200),
      links,
    });
  }
  return postProcess(verdicts, messages, cfg);
}

/** Shared post-processing: ignore keywords, notify threshold, redaction, link filtering. */
export function postProcess(
  verdicts: Verdict[],
  messages: IncomingMessage[],
  cfg: FactotumConfig,
): Verdict[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return verdicts
    .filter((v) => {
      const msg = byId.get(v.messageId);
      return msg ? !matchesIgnore(msg.text, cfg) : true;
    })
    .map((v) => {
      const msg = byId.get(v.messageId);
      const realLinks = new Set(msg ? extractLinks(msg.text) : []);
      return {
        ...v,
        notify: v.score >= cfg.minScore || v.category === "scam",
        title: redactSecrets(v.title).slice(0, 60),
        summary: redactSecrets(v.summary).slice(0, 200),
        links: v.links.filter((l) => realLinks.has(l)),
      };
    });
}

let warnedNoKey = false;

export async function classifyBatch(
  messages: IncomingMessage[],
  context: IncomingMessage[],
  cfg: FactotumConfig,
): Promise<Verdict[]> {
  if (messages.length === 0) return [];
  if (cfg.llm.provider === "none") return classifyHeuristic(messages, cfg);
  const apiKey = apiKeyForProvider(cfg.llm.provider);
  if (!apiKey) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      logger.warn(
        { provider: cfg.llm.provider },
        "No API key for configured LLM provider — using built-in keyword heuristic. Set the key in .env for better accuracy.",
      );
    }
    return classifyHeuristic(messages, cfg);
  }

  const interests = cfg.interests.length
    ? cfg.interests.map((i) => `- ${i}`).join("\n")
    : "- Anything urgent, time-limited or requiring action";
  const untrusted = buildUntrustedDataBlock({
    messages: sanitizeIncomingMessages(messages),
    context: sanitizeIncomingMessages(context.slice(-10)),
  });

  try {
    const model = getModel(cfg.llm.provider, cfg.llm.model, apiKey);
    const { object } = await generateObject({
      model,
      schema: verdictSchema,
      prompt: PROMPT.replace("{{interests}}", interests)
        .replace("{{minScore}}", String(cfg.minScore))
        .replace("{{untrusted_block}}", untrusted),
    });
    const verdicts: Verdict[] = object.verdicts.map((v) => ({
      messageId: v.messageId,
      notify: false,
      score: v.score,
      category: v.category,
      urgency: v.urgency,
      title: v.title,
      summary: v.summary,
      deadline: v.deadline,
      links: v.links,
    }));
    return postProcess(verdicts, messages, cfg);
  } catch (err) {
    logger.warn(
      {
        err: redactSecrets(err instanceof Error ? err.message : String(err)),
      },
      "LLM classification failed — falling back to heuristic",
    );
    return classifyHeuristic(messages, cfg);
  }
}
