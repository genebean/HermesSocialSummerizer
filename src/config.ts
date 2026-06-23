import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

// quiet: true suppresses the dotenv v17 stdout banner ("◇ injected env …") which
// breaks MCP stdio framing — stdout must carry only JSON-RPC.
loadDotenv({ path: join(HERE, ".env"), quiet: true });

function envVar(name: string, required: boolean): string {
  const val = process.env[name];
  if (required && !val) throw new Error(`Required env var ${name} is not set — check your .env file`);
  return val ?? "";
}

function expandEnv(value: string | undefined, required = true): string {
  if (!value) return "";
  const m = value.match(/^\$\{(.+)\}$/);
  if (!m) return value;
  return envVar(m[1], required);
}

const MastodonAccountSchema = z.object({
  id: z.string().min(1),
  instance_url: z.string().url().refine((u) => u.startsWith("https://"), {
    message: "instance_url must use https://",
  }),
  access_token: z.string().min(1),
});

const BlueskyAccountSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  app_password: z.string().optional(),
});

const NostrAccountSchema = z.object({
  id: z.string().min(1),
  npub: z.string().startsWith("npub1"),
  relays: z.array(
    z.string().url().refine((u) => u.startsWith("wss://"), {
      message: "relay URL must use wss://",
    })
  ).min(1),
});

const AppConfigSchema = z.object({
  mastodon: z.array(MastodonAccountSchema).default([]),
  bluesky: z.array(BlueskyAccountSchema).default([]),
  nostr: z.array(NostrAccountSchema).default([]),
});

export type MastodonAccount = z.infer<typeof MastodonAccountSchema>;
export type BlueskyAccount = z.infer<typeof BlueskyAccountSchema>;
export type NostrAccount = z.infer<typeof NostrAccountSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(path?: string): AppConfig {
  const configPath = path ?? process.env.SOCIAL_READER_CONFIG ?? join(HERE, "config.yaml");
  const rawYaml = parseYaml(readFileSync(configPath, "utf-8")) ?? {};

  if (typeof rawYaml !== "object" || Array.isArray(rawYaml)) {
    throw new Error("config.yaml must be a YAML mapping at the top level");
  }

  const raw = rawYaml as Record<string, unknown>;

  // Expand ${ENV_VAR} references before schema validation so zod sees real values.
  const expanded = {
    mastodon: Array.isArray(raw.mastodon)
      ? raw.mastodon.map((a: Record<string, string>) => ({
          ...a,
          access_token: expandEnv(a.access_token),
        }))
      : [],
    bluesky: Array.isArray(raw.bluesky)
      ? raw.bluesky.map((a: Record<string, string>) => ({
          ...a,
          app_password: expandEnv(a.app_password, false) || undefined,
        }))
      : [],
    nostr: Array.isArray(raw.nostr)
      ? raw.nostr.map((a: Record<string, unknown>) => ({ ...a }))
      : [],
  };

  const result = AppConfigSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config.yaml:\n${issues}`);
  }
  return result.data;
}
