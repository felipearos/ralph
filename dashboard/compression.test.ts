import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { Asset } from "./build";
import { compressResponse, createAssetCompressionCache, negotiate, zlibCompressor, type Compressor } from "./compression";
import { createHandler } from "./server";

const big = JSON.stringify({ loops: Array.from({ length: 200 }, (_, i) => ({ name: `loop-${i}`, state: "idle" })) });
const jsonResponse = (body = big, extra: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const get = (encoding?: string, method = "GET") =>
  new Request("http://127.0.0.1/api/loops", {
    method,
    headers: encoding === undefined ? {} : { "accept-encoding": encoding },
  });
const decode = (bytes: ArrayBuffer, encoding: string | null) =>
  encoding === "br" ? brotliDecompressSync(Buffer.from(bytes)).toString() : gunzipSync(Buffer.from(bytes)).toString();

describe("negotiate", () => {
  it("reads weights, refusals, the wildcard and the br preference", () => {
    expect(negotiate(null)).toBeNull();
    expect(negotiate("")).toBeNull();
    expect(negotiate("identity")).toBeNull();
    expect(negotiate("gzip")).toBe("gzip");
    expect(negotiate("br")).toBe("br");
    expect(negotiate("gzip, deflate, br")).toBe("br");
    expect(negotiate("br;q=0.5, gzip")).toBe("gzip");
    expect(negotiate("br;q=0, gzip;q=0")).toBeNull();
    expect(negotiate("gzip;q=0")).toBeNull();
    expect(negotiate("*")).toBe("br");
    expect(negotiate("*;q=0.1, br;q=0")).toBe("gzip");
    expect(negotiate("*;q=0")).toBeNull();
    expect(negotiate("GZIP; Q=0.8")).toBe("gzip");
  });
});

describe("compressResponse", () => {
  it("round-trips gzip and br with the right headers", async () => {
    for (const encoding of ["gzip", "br"]) {
      const out = await compressResponse(get(encoding), jsonResponse(big, { "content-length": String(big.length), vary: "Origin" }));
      expect(out.status).toBe(200);
      expect(out.headers.get("content-encoding")).toBe(encoding);
      expect(out.headers.get("vary")).toBe("Origin, Accept-Encoding");
      expect(out.headers.get("content-type")).toBe("application/json");
      expect(out.headers.get("cache-control")).toBe("no-store");
      const bytes = await out.arrayBuffer();
      expect(bytes.byteLength).toBeLessThan(big.length);
      expect(decode(bytes, encoding)).toBe(big);
    }
  });

  it("leaves a response untouched without Accept-Encoding or when refused", async () => {
    for (const header of [undefined, "", "gzip;q=0", "identity"]) {
      const original = jsonResponse();
      expect(await compressResponse(get(header), original)).toBe(original);
    }
  });

  it("leaves HEAD, empty bodies, 304 and already-encoded responses untouched", async () => {
    const head = jsonResponse();
    expect(await compressResponse(get("gzip", "HEAD"), head)).toBe(head);
    const empty = new Response(null, { status: 302, headers: { location: "/p/x" } });
    expect(await compressResponse(get("gzip"), empty)).toBe(empty);
    const notModified = new Response(null, { status: 304 });
    expect(await compressResponse(get("gzip"), notModified)).toBe(notModified);
    const encoded = jsonResponse(big, { "content-encoding": "gzip" });
    expect(await compressResponse(get("gzip"), encoded)).toBe(encoded);
  });

  it("passes an SSE stream through as the same object without reading it", async () => {
    let pulled = false;
    const body = new ReadableStream({
      pull() {
        pulled = true;
        return new Promise(() => {}); // never closes
      },
    }, { highWaterMark: 0 }); // no eager pull, so `pulled` means somebody read it
    const sse = new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    expect(await compressResponse(get("gzip, br"), sse)).toBe(sse);
    expect(sse.bodyUsed).toBe(false);
    expect(pulled).toBe(false);
    await body.cancel();
  });

  it("leaves incompressible types alone", async () => {
    const png = new Response(new Uint8Array(4096), { headers: { "content-type": "image/png" } });
    expect(await compressResponse(get("gzip"), png)).toBe(png);
  });

  it("serves a small body as is, without Content-Encoding", async () => {
    const out = await compressResponse(get("gzip"), jsonResponse('{"ok":true}'));
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(out.headers.get("vary")).toBe("Accept-Encoding");
    expect(await out.text()).toBe('{"ok":true}');
  });

  it("falls back to the plain body when compression fails", async () => {
    const failing: Compressor = async () => {
      throw new Error("zlib broke");
    };
    const out = await compressResponse(get("gzip"), jsonResponse(), failing);
    expect(out.status).toBe(200);
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(await out.text()).toBe(big);
  });
});

describe("createHandler", () => {
  const script = `console.log(${JSON.stringify("x".repeat(8000))});`;
  const assets = new Map<string, Asset>([
    ["/assets/app-abc.js", { body: new TextEncoder().encode(script), type: "application/javascript; charset=utf-8" }],
  ]);
  const handlerWith = () => {
    const compress = vi.fn(zlibCompressor);
    const handler = createHandler({
      adapter: { read: vi.fn() },
      shell: "<html>" + "<p>shell</p>".repeat(200) + "</html>",
      clock: () => ({ nowMs: 0 }),
      assets,
      assetCompression: createAssetCompressionCache(compress),
    });
    return { handler, compress };
  };
  const at = (path: string, encoding?: string) =>
    new Request(`http://127.0.0.1${path}`, { headers: encoding === undefined ? {} : { "accept-encoding": encoding } });

  it("compresses an asset once per encoding across requests", async () => {
    const { handler, compress } = handlerWith();
    const [first, second] = await Promise.all([handler(at("/assets/app-abc.js", "br")), handler(at("/assets/app-abc.js", "br"))]);
    const third = await handler(at("/assets/app-abc.js", "br"));
    for (const out of [first!, second!, third]) {
      expect(out.headers.get("content-encoding")).toBe("br");
      expect(out.headers.get("vary")).toBe("Accept-Encoding");
      expect(out.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(out.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
      expect(decode(await out.arrayBuffer(), "br")).toBe(script);
    }
    expect(compress).toHaveBeenCalledTimes(1);
    const gz = await handler(at("/assets/app-abc.js", "gzip"));
    expect(decode(await gz.arrayBuffer(), "gzip")).toBe(script);
    expect(compress).toHaveBeenCalledTimes(2);
  });

  it("serves an asset plain, and never recompresses it per request, when its one compression failed", async () => {
    const compress = vi.fn<Compressor>(async () => {
      throw new Error("brotli ran out of memory");
    });
    const handler = createHandler({
      adapter: { read: vi.fn() },
      shell: "",
      clock: () => ({ nowMs: 0 }),
      assets,
      assetCompression: createAssetCompressionCache(compress),
    });
    for (let i = 0; i < 2; i++) {
      const out = await handler(at("/assets/app-abc.js", "br"));
      expect(out.status).toBe(200);
      expect(out.headers.get("content-encoding")).toBeNull();
      expect(await out.text()).toBe(script);
    }
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it("serves an asset exactly as before without Accept-Encoding", async () => {
    const { handler, compress } = handlerWith();
    const out = await handler(at("/assets/app-abc.js"));
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(out.headers.get("vary")).toBeNull();
    expect(await out.text()).toBe(script);
    expect(compress).not.toHaveBeenCalled();
  });

  it("compresses the shell and leaves it unchanged without Accept-Encoding", async () => {
    const { handler } = handlerWith();
    const gz = await handler(at("/", "gzip"));
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(decode(await gz.arrayBuffer(), "gzip")).toContain("<p>shell</p>");
    const plain = await handler(at("/"));
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toBeNull();
    expect(await plain.text()).toContain("<p>shell</p>");
  });
});
