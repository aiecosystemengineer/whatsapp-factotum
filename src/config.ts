import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const configSchema = z.object({
  watchedGroups: z
    .array(
      z.object({
        id: z.string().endsWith("@g.us", "Group JIDs must end with @g.us"),
        name: z.string().optional(),
      }),
    )
    .default([]),
  interests: z.array(z.string()).default([]),
  ignoreKeywords: z.array(z.string()).default([]),
  minScore: z.number().min(0).max(100).default(60),
  batchWindowSeconds: z.number().positive().default(20),
  notify: z
    .object({
      ntfyTopic: z.string().optional(),
      ntfyServer: z.string().default("https://ntfy.sh"),
      selfChat: z.boolean().default(true),
    })
    .default({ ntfyServer: "https://ntfy.sh", selfChat: true }),
  llm: z
    .object({
      provider: z
        .enum(["anthropic", "openai", "google", "openrouter", "none"])
        .default("anthropic"),
      model: z.string().optional(),
    })
    .default({ provider: "anthropic" }),
  digest: z
    .object({
      enabled: z.boolean().default(true),
      hour: z.number().int().min(0).max(23).default(21),
    })
    .default({ enabled: true, hour: 21 }),
});

export type FactotumConfig = z.infer<typeof configSchema>;

export type LlmProvider = FactotumConfig["llm"]["provider"];

const PROVIDER_ENV: Record<Exclude<LlmProvider, "none">, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function apiKeyForProvider(provider: LlmProvider): string {
  if (provider === "none") return "";
  return (process.env[PROVIDER_ENV[provider]] || "").trim();
}

export function defaultConfig(): FactotumConfig {
  return configSchema.parse({});
}

const CONFIG_PATH = path.join(process.cwd(), "factotum.config.json");
const EXAMPLE_PATH = path.join(process.cwd(), "factotum.config.example.json");

export function loadConfig(): FactotumConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    const hint = fs.existsSync(EXAMPLE_PATH)
      ? `cp factotum.config.example.json factotum.config.json`
      : "create factotum.config.json (see README)";
    throw new Error(
      `Missing ${CONFIG_PATH}.\n` +
        `Create it first:\n  ${hint}\n` +
        `Then run "npm run groups" to find your group JIDs and paste them into watchedGroups.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(
      `factotum.config.json is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `factotum.config.json is invalid:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  return parsed.data;
}
