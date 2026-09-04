import assert from "node:assert/strict";
import { describe, it } from "node:test";
import webToolsExtension, { __test__readBoundedUtf8 } from "../pi-extension/subagents/tools/web-tools.ts";

function byteStream(
  chunks: Uint8Array[],
  onCancel?: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index === chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

describe("web_fetch bounded streaming", () => {
  it("decodes UTF-8 code points split across stream chunks", async () => {
    const encoded = new TextEncoder().encode("A😀éZ");
    const body = byteStream([
      encoded.subarray(0, 3),
      encoded.subarray(3, 6),
      encoded.subarray(6),
    ]);

    assert.deepEqual(await __test__readBoundedUtf8(body, 100), {
      text: "A😀éZ",
      truncated: false,
    });
  });

  it("retains only the byte-bounded prefix and cancels an oversized body", async () => {
    let cancelCount = 0;
    const encoder = new TextEncoder();
    const body = byteStream(
      [encoder.encode("abc"), encoder.encode("def"), encoder.encode("never read")],
      () => cancelCount++,
    );

    assert.deepEqual(await __test__readBoundedUtf8(body, 5), {
      text: "abcde",
      truncated: true,
    });
    assert.equal(cancelCount, 1);
  });

  it("does not emit a replacement character when the byte limit splits UTF-8", async () => {
    let cancelled = false;
    const encoded = new TextEncoder().encode("ok😀later");
    const result = await __test__readBoundedUtf8(
      byteStream([encoded], () => {
        cancelled = true;
      }),
      4,
    );

    assert.deepEqual(result, { text: "ok", truncated: true });
    assert.equal(cancelled, true);
  });

  it("preserves an abort reason and stops the body", async () => {
    const controller = new AbortController();
    const reason = new DOMException("test abort", "AbortError");
    let cancelReason: unknown;
    let releasePull: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          return new Promise<void>((resolve) => {
            releasePull = resolve;
          });
        },
        cancel(value) {
          cancelReason = value;
          releasePull?.();
        },
      },
      { highWaterMark: 0 },
    );

    const reading = __test__readBoundedUtf8(body, 100, controller.signal);
    controller.abort(reason);

    await assert.rejects(reading, (error) => error === reason);
    assert.equal(cancelReason, reason);
  });

  it("keeps web_fetch response details while reporting stream truncation", async () => {
    let execute: any;
    webToolsExtension({
      registerTool(tool: any) {
        if (tool.name === "web_fetch") execute = tool.execute;
      },
    } as any);

    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        byteStream([new Uint8Array(180_001).fill(97)], () => {
          cancelled = true;
        }),
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );

    try {
      const result = await execute("call", { url: "https://example.test/data" }, undefined);
      assert.equal(result.details.url, "https://example.test/data");
      assert.equal(result.details.status, 200);
      assert.equal(result.details.contentType, "text/plain; charset=utf-8");
      assert.equal(result.details.truncated, true);
      assert.equal(cancelled, true);
      assert.match(result.content[0].text, /\[Output truncated at 45000 characters\]$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
