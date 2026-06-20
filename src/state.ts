import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { HERE } from "./config.js";

const STATE_PATH = process.env.CURSOR_STATE_PATH ?? join(HERE, "cursor_state.json");

type CursorStore = Record<string, Record<string, Record<string, unknown>>>;

export function loadState(): CursorStore {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as CursorStore;
  } catch {
    return {};
  }
}

export function saveState(state: CursorStore): void {
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

export function getCursor(state: CursorStore, platform: string, accountId: string): Record<string, unknown> {
  return state[platform]?.[accountId] ?? {};
}

export function setCursor(state: CursorStore, platform: string, accountId: string, cursor: Record<string, unknown>): void {
  if (!state[platform]) state[platform] = {};
  state[platform][accountId] = cursor;
}
