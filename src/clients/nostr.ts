/**
 * Read-only Nostr client.
 *
 * Strongest read-only guarantee of the three platforms: only the public key
 * (npub/hex) is ever present. The private key (nsec) has no place in this
 * codebase. Publishing requires signing with nsec, so without it no event
 * can be broadcast — this isn't a permission you turned off, the capability
 * simply isn't present.
 */
import { SimplePool } from "nostr-tools/pool";
import { decode as bech32Decode } from "nostr-tools/nip19";
import type { Filter } from "nostr-tools";

const CONNECT_TIMEOUT = 4_000;
const CONTACT_TTL_MS = 5 * 60 * 1000;

type NostrEvent = { id: string; pubkey: string; created_at: number; content: string; tags: string[][] };

export function npubToHex(npub: string): string {
  const decoded = bech32Decode(npub);
  if (decoded.type !== "npub") throw new Error(`Expected npub, got ${decoded.type}`);
  return decoded.data as string;
}

export interface NostrNote {
  id: string;
  author: string;
  created_at: number;
  text: string;
}

export interface NostrRepost {
  id: string;
  created_at: number;
  reposted_event_id: string | null;
}

export type NostrBookmark =
  | { kind: "event"; event_id: string }
  | { kind: "article"; article_addr: string };

export interface NostrZap {
  id: string;
  created_at: number;
  zapped_event_id: string | null;
  recipient_pubkey: string | null;
  amount_sats: number | null;
  message: string;
}

export class NostrReadClient {
  private readonly pubkey: string;
  private readonly relays: string[];
  private readonly pool = new SimplePool();
  private contactCache?: { pubkeys: string[]; fetchedAt: number };

  constructor(pubkeyHex: string, relays: string[]) {
    this.pubkey = pubkeyHex;
    this.relays = relays;
  }

  close(): void {
    this.pool.close(this.relays);
  }

  private async fetchEvents(filter: Filter): Promise<NostrEvent[]> {
    const seen = new Set<string>();
    const events: NostrEvent[] = [];

    await new Promise<void>((resolve) => {
      this.pool.subscribeManyEose(this.relays, filter, {
        onevent(event) {
          if (!seen.has(event.id)) {
            seen.add(event.id);
            events.push(event);
          }
        },
        onclose() { resolve(); },
        maxWait: CONNECT_TIMEOUT,
      });
    });

    return events;
  }

  private async getFollowed(): Promise<string[]> {
    if (this.contactCache && Date.now() - this.contactCache.fetchedAt < CONTACT_TTL_MS) {
      return this.contactCache.pubkeys;
    }
    const events = await this.fetchEvents({ kinds: [3], authors: [this.pubkey], limit: 1 });
    const pubkeys = parseContactList(events);
    this.contactCache = { pubkeys, fetchedAt: Date.now() };
    return pubkeys;
  }

  async followingFeed(hours = 24, limit = 100, sinceTs?: number): Promise<NostrNote[]> {
    const followed = await this.getFollowed();
    if (followed.length === 0) return [];

    const since = sinceTs ?? Math.floor(Date.now() / 1000) - hours * 3600;
    const notes = await this.fetchEvents({ kinds: [1], authors: followed, since, limit });

    return notes
      .sort((a, b) => b.created_at - a.created_at)
      .map(simplifyNote);
  }

  async myReactions(limit = 100): Promise<NostrNote[]> {
    const events = await this.fetchEvents({ kinds: [7], authors: [this.pubkey], limit });
    return events.map(simplifyNote);
  }

  async myZaps(limit = 100): Promise<NostrZap[]> {
    // Kind 9735: zap receipts published by the recipient's Lightning provider.
    // The #P tag (capital P) indexes the sender's pubkey, letting us find zaps we sent.
    const events = await this.fetchEvents({ kinds: [9735], "#P": [this.pubkey], limit } as Filter);

    return events.map((e) => {
      const zapRequestJson = e.tags.find((t) => t[0] === "description")?.[1];
      let amount: number | null = null;
      let message = "";
      if (zapRequestJson) {
        if (zapRequestJson.length > 4096) {
          console.error(`[nostr] Oversized zap description on event ${e.id} (${zapRequestJson.length} bytes), skipping parse`);
        } else {
          try {
            const req = JSON.parse(zapRequestJson);
            message = req.content ?? "";
            const amountTag = (req.tags as string[][])?.find((t) => t[0] === "amount");
            if (amountTag) amount = Math.round(Number(amountTag[1]) / 1000);
          } catch (err) {
            console.error(`[nostr] Malformed zap request on event ${e.id}:`, err);
          }
        }
      }
      return {
        id: e.id,
        created_at: e.created_at,
        zapped_event_id: e.tags.find((t) => t[0] === "e")?.[1] ?? null,
        recipient_pubkey: e.tags.find((t) => t[0] === "p")?.[1] ?? null,
        amount_sats: amount,
        message,
      };
    });
  }

  async myBookmarks(): Promise<NostrBookmark[]> {
    // Kind 10003: NIP-51 replaceable bookmark list. Fetch the latest event only.
    const events = await this.fetchEvents({ kinds: [10003], authors: [this.pubkey], limit: 1 });
    if (events.length === 0) return [];
    // limit: 1 was sent to the relay, so events[0] is the only (or latest) result.
    const latest = events[0];
    return latest.tags
      .filter((t) => t[0] === "e" || t[0] === "a")
      .map((t): NostrBookmark =>
        t[0] === "e"
          ? { kind: "event", event_id: t[1] }
          : { kind: "article", article_addr: t[1] }
      );
  }

  async myReposts(limit = 100): Promise<NostrRepost[]> {
    const events = await this.fetchEvents({ kinds: [6], authors: [this.pubkey], limit });
    return events.map((e) => ({
      id: e.id,
      created_at: e.created_at,
      reposted_event_id: e.tags.find((t) => t[0] === "e")?.[1] ?? null,
    }));
  }
}

function parseContactList(events: { created_at: number; tags: string[][] }[]): string[] {
  if (events.length === 0) return [];
  const latest = events.reduce((a, b) => (a.created_at > b.created_at ? a : b));
  return latest.tags.filter((t) => t[0] === "p").map((t) => t[1]);
}

function simplifyNote(e: { id: string; pubkey: string; created_at: number; content: string }): NostrNote {
  return { id: e.id, author: e.pubkey, created_at: e.created_at, text: e.content };
}
