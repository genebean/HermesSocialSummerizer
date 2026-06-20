import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

loadDotenv({ path: join(HERE, ".env") });

export interface MastodonAccount {
  id: string;
  instance_url: string;
  access_token: string;
}

export interface BlueskyAccount {
  id: string;
  handle: string;
  app_password?: string;
}

export interface NostrAccount {
  id: string;
  npub: string;
  relays: string[];
}

export interface AppConfig {
  mastodon: MastodonAccount[];
  bluesky: BlueskyAccount[];
  nostr: NostrAccount[];
}

export function expandEnv(value: string | undefined): string {
  if (!value) return "";
  const m = value.match(/^\$\{(.+)\}$/);
  return m ? (process.env[m[1]] ?? "") : value;
}

export function loadConfig(path?: string): AppConfig {
  const configPath = path ?? process.env.SOCIAL_READER_CONFIG ?? join(HERE, "config.yaml");
  const raw = parseYaml(readFileSync(configPath, "utf-8")) ?? {};

  return {
    mastodon: (raw.mastodon ?? []).map((a: Record<string, string>) => ({
      id: a.id,
      instance_url: a.instance_url,
      access_token: expandEnv(a.access_token),
    })),
    bluesky: (raw.bluesky ?? []).map((a: Record<string, string>) => ({
      id: a.id,
      handle: a.handle,
      app_password: expandEnv(a.app_password) || undefined,
    })),
    nostr: (raw.nostr ?? []).map((a: Record<string, unknown>) => ({
      id: a.id as string,
      npub: a.npub as string,
      relays: (a.relays as string[]) ?? [],
    })),
  };
}
