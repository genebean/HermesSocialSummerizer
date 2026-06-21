/** Post-processing helpers for token reduction in MCP responses. */

export function trunc(s: string, len: number): string {
  return s.length <= len ? s : `${s.slice(0, len)} …[+${s.length - len} chars]`;
}

export function clean<T extends object>(
  post: T,
  includeHtml: boolean,
  maxLen?: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(post)) {
    if ((k === "text_html" || k === "original_text_html") && !includeHtml) continue;
    if (maxLen !== undefined && typeof v === "string" &&
        (k === "text" || k === "original_text" || k === "content")) {
      out[k] = trunc(v, maxLen);
    } else {
      out[k] = v;
    }
  }
  return out;
}
