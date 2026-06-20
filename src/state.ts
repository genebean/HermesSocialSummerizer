import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { HERE } from "./config.js";

const STATE_PATH = process.env.CURSOR_STATE_PATH ?? join(HERE, "cursor_state.json");

// Known cursor fields per platform — avoids Record<string, unknown> casts at call sites.
export type PlatformCursor = {
  since_id?: string;  // mastodon
  since?: string;     // bluesky
  since_ts?: number;  // nostr
};

type CursorStore = Record<string, Record<string, PlatformCursor>>;

function loadFromDisk(): CursorStore {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as CursorStore;
  } catch (e) {
    console.error(`[state] Failed to parse ${STATE_PATH}, starting with empty cursors:`, e);
    return {};
  }
}

// Loaded once at startup; mutations go through saveState which also persists to disk.
let _state: CursorStore = loadFromDisk();

export function loadState(): CursorStore {
  return _state;
}

export function saveState(state: CursorStore): void {
  _state = state;
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

export function getCursor(state: CursorStore, platform: string, accountId: string): PlatformCursor {
  return state[platform]?.[accountId] ?? {};
}

export function setCursor(state: CursorStore, platform: string, accountId: string, cursor: PlatformCursor): void {
  if (!state[platform]) state[platform] = {};
  state[platform][accountId] = cursor;
}
