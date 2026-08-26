import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_OUTPUT_CHARS = 45_000;
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
      const raw = await response.text();
      const readable = contentType.includes("text/html") ? htmlToText(raw) : raw.trim();
      const output = bounded(readable);
      return {
        content: [{ type: "text" as const, text: output.text || "(empty response)" }],
        details: {
          url: response.url || url.toString(),
          status: response.status,
          contentType,
          truncated: output.truncated,
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
