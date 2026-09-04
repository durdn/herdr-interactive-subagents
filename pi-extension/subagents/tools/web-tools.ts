import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_OUTPUT_CHARS = 45_000;
// Four bytes can encode any Unicode code point, so this still permits a full
// output-sized UTF-8 response without allowing an unbounded raw download.
const MAX_DOWNLOAD_BYTES = MAX_OUTPUT_CHARS * 4;
const USER_AGENT = "herdr-interactive-subagents/4.0 (+https://github.com/durdn/herdr-interactive-subagents)";

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Number(value)));
}

function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function bounded(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_OUTPUT_CHARS} characters]`,
    truncated: true,
  };
}

/** Exported only for focused stream tests. */
export async function __test__readBoundedUtf8(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  signal?.throwIfAborted();
  if (!body) return { text: "", truncated: false };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let completed = false;
  let cancelPromise: Promise<void> | undefined;

  const stop = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason);
    return cancelPromise;
  };
  const onAbort = () => {
    void stop(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();

      if (done) {
        completed = true;
        text += decoder.decode();
        return { text, truncated: false };
      }
      if (value.byteLength === 0) continue;

      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        // Keep only complete UTF-8 characters from the bounded prefix. Not
        // flushing the decoder deliberately drops a partial final code point.
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
        return { text, truncated: true };
      }

      text += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
      // If the body is exactly maxBytes, one further read is needed to
      // distinguish a complete body from a truncated one. No bytes from that
      // bounded look-ahead are retained.
    }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) await stop(signal?.reason).catch(() => {});
    reader.releaseLock();
  }
}

function requireHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch only supports http:// and https:// URLs");
  }
  return url;
}

function resultUrl(rawHref: string): string {
  const href = decodeHtml(rawHref);
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return href;
  }
}

export default function webToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch an HTTP(S) URL and return readable text. Output is capped at 45,000 characters.",
    parameters: Type.Object({
      url: Type.String({ description: "HTTP(S) URL to fetch" }),
    }),
    async execute(_toolCallId, params, signal) {
      const url = requireHttpUrl(params.url);
      const response = await fetch(url, {
        signal,
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      });
      if (!response.ok) throw new Error(`web_fetch failed: HTTP ${response.status} ${response.statusText}`);

      const contentType = response.headers.get("content-type") ?? "";
      const raw = await __test__readBoundedUtf8(response.body, MAX_DOWNLOAD_BYTES, signal);
      const readable = contentType.includes("text/html") ? htmlToText(raw.text) : raw.text.trim();
      const output = bounded(readable);
      const truncated = raw.truncated || output.truncated;
      return {
        content: [{ type: "text" as const, text: output.text || "(empty response)" }],
        details: {
          url: response.url || url.toString(),
          status: response.status,
          contentType,
          truncated,
        },
      };
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web through DuckDuckGo's HTML endpoint and return result titles and URLs.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params, signal) {
      const limit = params.limit ?? 5;
      const searchUrl = new URL("https://html.duckduckgo.com/html/");
      searchUrl.searchParams.set("q", params.query);
      const response = await fetch(searchUrl, {
        signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html" },
      });
      if (!response.ok) throw new Error(`web_search failed: HTTP ${response.status} ${response.statusText}`);

      const html = await response.text();
      const results: Array<{ title: string; url: string }> = [];
      const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      for (const match of html.matchAll(pattern)) {
        const title = htmlToText(match[2]);
        const url = resultUrl(match[1]);
        if (!title || !url) continue;
        results.push({ title, url });
        if (results.length >= limit) break;
      }

      if (results.length === 0) {
        throw new Error("web_search returned no parseable results");
      }
      const text = results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}`).join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { query: params.query, results },
      };
    },
  });
}
