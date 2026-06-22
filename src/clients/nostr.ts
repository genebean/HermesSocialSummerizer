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
import { decode as bech32Decode, npubEncode, noteEncode } from "nostr-tools/nip19";
import type { Filter } from "nostr-tools";

const CONNECT_TIMEOUT = 4_000;
const CONTACT_TTL_MS = 5 * 60 * 1000;
const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

type NostrEvent = { id: string; pubkey: string; kind: number; created_at: number; content: string; tags: string[][] };

export function npubToHex(npub: string): string {
  const decoded = bech32Decode(npub);
  if (decoded.type !== "npub") throw new Error(`Expected npub, got ${decoded.type}`);
  return decoded.data as string;
}

export interface NostrEngagement {
  reactions: number;
  reposts: number;
  zaps: number;
  zap_total_sats: number;
}

export interface NostrNote {
  id: string;
  nostr_uri: string;
  author: string;
  author_npub: string;
  created_at: number;
  text: string;
  hashtags: string[];
  urls: string[];
  mentioned_pubkeys: string[];
  reply_to_id: string | null;
  root_id: string | null;
  engagement?: NostrEngagement;
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

export interface NostrProfile {
  pubkey: string;
  npub: string;
  name: string | null;
  display_name: string | null;
  about: string | null;
  picture: string | null;
  website: string | null;
  nip05: string | null;
}

export interface NostrArticle {
  id: string;
  nostr_uri: string;
  author: string;
  author_npub: string;
  published_at: number | null;
  title: string | null;
  summary: string | null;
  content: string;
  image: string | null;
  hashtags: string[];
  urls: string[];
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

  async followingFeed(hours = 24, limit = 100, sinceTs?: number, includeEngagement = false, maxPages = 1): Promise<NostrNote[]> {
    const followed = await this.getFollowed();
    if (followed.length === 0) return [];

    const since = sinceTs ?? Math.floor(Date.now() / 1000) - hours * 3600;
    const seenIds = new Set<string>();
    const allEvents: NostrEvent[] = [];
    let until: number | undefined;

    for (let page = 0; page < maxPages; page++) {
      const filter: Filter = { kinds: [1], authors: followed, since, limit };
      if (until !== undefined) filter.until = until;
      const events = await this.fetchEvents(filter);
      let newCount = 0;
      for (const e of events) {
        if (!seenIds.has(e.id)) {
          seenIds.add(e.id);
          allEvents.push(e);
          newCount++;
        }
      }
      if (newCount < limit) break;
      until = Math.min(...events.map((e) => e.created_at)) - 1;
    }

    const notes = allEvents.sort((a, b) => b.created_at - a.created_at).map(simplifyNote);

    if (includeEngagement && notes.length > 0) {
      const engMap = await this.fetchEngagement(notes.map((n) => n.id));
      for (const note of notes) {
        const eng = engMap.get(note.id);
        if (eng) note.engagement = eng;
      }
    }

    return notes;
  }

  // Fetches reaction (kind 7), repost (kind 6), and zap receipt (kind 9735) counts
  // for the given event IDs in a single relay query. Counts are approximate —
  // relays may not have all events and the result limit is 1000 per batch.
  private async fetchEngagement(eventIds: string[]): Promise<Map<string, NostrEngagement>> {
    const events = await this.fetchEvents({
      kinds: [6, 7, 9735],
      "#e": eventIds,
      limit: 1000,
    } as Filter);

    const map = new Map<string, NostrEngagement>();
    const init = (): NostrEngagement => ({ reactions: 0, reposts: 0, zaps: 0, zap_total_sats: 0 });

    for (const e of events) {
      const targetId = e.tags.find((t) => t[0] === "e")?.[1];
      if (!targetId || !eventIds.includes(targetId)) continue;
      if (!map.has(targetId)) map.set(targetId, init());
      const eng = map.get(targetId)!;

      if (e.kind === 7) {
        eng.reactions++;
      } else if (e.kind === 6) {
        eng.reposts++;
      } else if (e.kind === 9735) {
        eng.zaps++;
        const desc = e.tags.find((t) => t[0] === "description")?.[1];
        if (desc && desc.length <= 4096) {
          try {
            const req = JSON.parse(desc);
            const amountTag = (req.tags as string[][])?.find((t) => t[0] === "amount");
            if (amountTag) eng.zap_total_sats += Math.round(Number(amountTag[1]) / 1000);
          } catch { /* skip malformed zap request */ }
        }
      }
    }

    return map;
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

  async getEvent(eventId: string): Promise<NostrNote | null> {
    const events = await this.fetchEvents({ ids: [eventId], limit: 1 });
    return events.length > 0 ? simplifyNote(events[0]) : null;
  }

  async getEvents(eventIds: string[]): Promise<NostrNote[]> {
    if (eventIds.length === 0) return [];
    const events = await this.fetchEvents({ ids: eventIds, limit: eventIds.length });
    return events.map(simplifyNote);
  }

  async getProfile(pubkeyHex: string): Promise<NostrProfile | null> {
    const events = await this.fetchEvents({ kinds: [0], authors: [pubkeyHex], limit: 1 });
    if (events.length === 0) return null;
    const e = events[0];
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(e.content) as Record<string, unknown>;
    } catch { /* malformed profile metadata, return with empty fields */ }
    const str = (k: string): string | null => (typeof meta[k] === "string" ? meta[k] as string : null);
    return {
      pubkey: e.pubkey,
      npub: npubEncode(e.pubkey),
      name: str("name"),
      display_name: str("display_name"),
      about: str("about"),
      picture: str("picture"),
      website: str("website"),
      nip05: str("nip05"),
    };
  }

  async getArticle(articleAddr: string): Promise<NostrArticle | null> {
    // article_addr format from NIP-51 bookmark lists: "30023:<pubkey_hex>:<d-tag>[:<relay_hint>]"
    const parts = articleAddr.split(":");
    if (parts[0] !== "30023" || parts.length < 3) {
      throw new Error(`Invalid article_addr: "${articleAddr}". Expected "30023:<pubkey>:<d-tag>".`);
    }
    const [, pubkey, dTag] = parts;
    const events = await this.fetchEvents({
      kinds: [30023],
      authors: [pubkey],
      "#d": [dTag],
      limit: 1,
    } as Filter);
    if (events.length === 0) return null;
    const e = events[0];
    const tag = (name: string): string | null => e.tags.find((t) => t[0] === name)?.[1] ?? null;
    const publishedAt = tag("published_at");
    return {
      id: e.id,
      nostr_uri: `nostr:${noteEncode(e.id)}`,
      author: e.pubkey,
      author_npub: npubEncode(e.pubkey),
      published_at: publishedAt !== null ? Number(publishedAt) : null,
      title: tag("title"),
      summary: tag("summary"),
      content: e.content,
      image: tag("image"),
      hashtags: e.tags.filter((t) => t[0] === "t").map((t) => t[1]),
      urls: [...new Set(e.content.match(URL_RE) ?? [])],
    };
  }
}

function parseContactList(events: { created_at: number; tags: string[][] }[]): string[] {
  if (events.length === 0) return [];
  const latest = events.reduce((a, b) => (a.created_at > b.created_at ? a : b));
  return latest.tags.filter((t) => t[0] === "p").map((t) => t[1]);
}

function extractReplyRoot(tags: string[][]): { reply_to_id: string | null; root_id: string | null } {
  // NIP-10: 'e' tags may carry positional markers "root" / "reply".
  // If no markers, legacy convention: first 'e' = root, last 'e' = direct parent.
  const eTags = tags.filter((t) => t[0] === "e");
  if (eTags.length === 0) return { reply_to_id: null, root_id: null };

  const rootTag = eTags.find((t) => t[3] === "root");
  const replyTag = eTags.find((t) => t[3] === "reply");

  if (rootTag || replyTag) {
    return {
      root_id: rootTag?.[1] ?? null,
      reply_to_id: replyTag?.[1] ?? null,
    };
  }

  // Legacy: no markers
  return {
    root_id: eTags[0][1],
    reply_to_id: eTags.length > 1 ? eTags[eTags.length - 1][1] : null,
  };
}

function simplifyNote(e: NostrEvent): NostrNote {
  const { reply_to_id, root_id } = extractReplyRoot(e.tags);
  return {
    id: e.id,
    nostr_uri: `nostr:${noteEncode(e.id)}`,
    author: e.pubkey,
    author_npub: npubEncode(e.pubkey),
    created_at: e.created_at,
    text: e.content,
    hashtags: e.tags.filter((t) => t[0] === "t").map((t) => t[1]),
    urls: [...new Set(e.content.match(URL_RE) ?? [])],
    mentioned_pubkeys: e.tags.filter((t) => t[0] === "p").map((t) => t[1]),
    reply_to_id,
    root_id,
  };
}
