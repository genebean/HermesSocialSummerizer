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

const CONNECT_TIMEOUT = 10_000;

export function npubToHex(npub: string): string {
  const decoded = bech32Decode(npub);
  if (decoded.type !== "npub") throw new Error(`Expected npub, got ${decoded.type}`);
  return decoded.data as string;
}

async function fetchEvents(relays: string[], filter: Filter): Promise<{ id: string; pubkey: string; created_at: number; content: string; tags: string[][] }[]> {
  const pool = new SimplePool();
  const seen = new Set<string>();
  const events: { id: string; pubkey: string; created_at: number; content: string; tags: string[][] }[] = [];

  await new Promise<void>((resolve) => {
    pool.subscribeManyEose(relays, filter, {
      onevent(event) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          events.push(event);
        }
      },
      onclose() {
        pool.close(relays);
        resolve();
      },
      maxWait: CONNECT_TIMEOUT,
    });
  });

  return events;
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

export interface NostrBookmark {
  event_id: string;
  article_addr: string | null;
}

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

  constructor(pubkeyHex: string, relays: string[]) {
    this.pubkey = pubkeyHex;
    this.relays = relays;
  }

  async followingFeed(hours = 24, limit = 100, sinceTs?: number): Promise<NostrNote[]> {
    const contactEvents = await fetchEvents(this.relays, {
      kinds: [3],
      authors: [this.pubkey],
      limit: 1,
    });

    const followed = parseContactList(contactEvents);
    if (followed.length === 0) return [];

    const since = sinceTs ?? Math.floor(Date.now() / 1000) - hours * 3600;
    const notes = await fetchEvents(this.relays, {
      kinds: [1],
      authors: followed,
      since,
      limit,
    });

    return notes
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit)
      .map(simplifyNote);
  }

  async myReactions(limit = 100): Promise<NostrNote[]> {
    const events = await fetchEvents(this.relays, {
      kinds: [7],
      authors: [this.pubkey],
      limit,
    });
    return events.map(simplifyNote);
  }

  async myZaps(limit = 100): Promise<NostrZap[]> {
    // Kind 9735: zap receipts published by the recipient's Lightning provider.
    // The #P tag (capital P) indexes the sender's pubkey, letting us find zaps we sent.
    const events = await fetchEvents(this.relays, {
      kinds: [9735],
      "#P": [this.pubkey],
      limit,
    } as Filter);

    return events.map((e) => {
      const zapRequestJson = e.tags.find((t) => t[0] === "description")?.[1];
      let amount: number | null = null;
      let message = "";
      if (zapRequestJson) {
        try {
          const req = JSON.parse(zapRequestJson);
          message = req.content ?? "";
          const amountTag = (req.tags as string[][])?.find((t) => t[0] === "amount");
          if (amountTag) amount = Math.round(Number(amountTag[1]) / 1000);
        } catch { /* malformed */ }
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
    const events = await fetchEvents(this.relays, {
      kinds: [10003],
      authors: [this.pubkey],
      limit: 1,
    });
    if (events.length === 0) return [];
    const latest = events.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    return latest.tags
      .filter((t) => t[0] === "e" || t[0] === "a")
      .map((t) => ({
        event_id: t[0] === "e" ? t[1] : "",
        article_addr: t[0] === "a" ? t[1] : null,
      }))
      .filter((b) => b.event_id || b.article_addr);
  }

  async myReposts(limit = 100): Promise<NostrRepost[]> {
    const events = await fetchEvents(this.relays, {
      kinds: [6],
      authors: [this.pubkey],
      limit,
    });
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
