/**
 * Response compression for the dashboard server (#69).
 *
 * Remote loads (Tailscale, the bridge) pay for every byte of a `/loops` poll
 * and of the bundled script, so the handler compresses what the client says
 * it accepts. Streams (SSE) pass through untouched: buffering one would hold
 * the client's live view until the stream ended, which it never does.
 */
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

export type Encoding = "br" | "gzip";

/** Below this a compressed body saves less than its headers cost. */
export const MIN_COMPRESS_BYTES = 1024;

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/**
 * The encoding this server produces for an `Accept-Encoding` header, or null
 * for none. Weights are honoured (`q=0` refuses), `*` stands for any coding not
 * named, and `br` wins a tie with `gzip` because it is smaller.
 */
export function negotiate(acceptEncoding: string | null): Encoding | null {
  if (acceptEncoding === null || acceptEncoding.trim() === "") return null;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = (rawName ?? "").trim().toLowerCase();
    if (name === "") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((s) => s.trim());
      if (key?.toLowerCase() === "q") q = Number(value);
    }
    // A malformed weight is ignored like a malformed token, not read as consent.
    if (!Number.isFinite(q) || q < 0 || q > 1) continue;
    weights.set(name, q);
  }
  const star = weights.get("*") ?? 0;
  const br = weights.get("br") ?? star;
  const gz = weights.get("gzip") ?? star;
  if (br <= 0 && gz <= 0) return null;
  return br >= gz ? "br" : "gzip";
}

/** Text-like bodies shrink; images, fonts and octet-streams are already dense. */
export function compressible(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/javascript" ||
    type.endsWith("+json") ||
    type === "image/svg+xml"
  );
}

function isEventStream(contentType: string | null): boolean {
  return contentType?.split(";")[0]!.trim().toLowerCase() === "text/event-stream";
}

/** Adds `accept-encoding` to a `vary` value once, keeping what was there. */
export function mergeVary(existing: string | null): string {
  if (existing === null || existing.trim() === "") return "Accept-Encoding";
  const tokens = existing.split(",").map((t) => t.trim().toLowerCase());
  if (tokens.includes("*") || tokens.includes("accept-encoding")) return existing;
  return `${existing}, Accept-Encoding`;
}

/** Compresses bytes; `quality` is brotli's (gzip keeps zlib's default level). */
export type Compressor = (body: Uint8Array, encoding: Encoding, quality: number) => Promise<Uint8Array<ArrayBuffer>>;

export const zlibCompressor: Compressor = async (body, encoding, quality) => {
  const out =
    encoding === "br"
      ? await brotliAsync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })
      : await gzipAsync(body);
  return new Uint8Array(out);
};

/** Low brotli quality for dynamic bodies, so a `/loops` poll stays cheap on the host. */
const DYNAMIC_BROTLI_QUALITY = 4;

function untouchable(request: Request, response: Response): boolean {
  if (request.method === "HEAD") return true;
  if (response.body === null) return true;
  const status = response.status;
  if (status < 200 || status === 204 || status === 206 || status === 304) return true;
  if (response.headers.has("content-encoding")) return true;
  return false;
}

/**
 * Compresses one response for one request, or returns the very same object
 * when it must not be touched. Never throws on a compression failure: the
 * uncompressed body is served instead.
 */
export async function compressResponse(
  request: Request,
  response: Response,
  compress: Compressor = zlibCompressor,
): Promise<Response> {
  const encoding = negotiate(request.headers.get("accept-encoding"));
  if (encoding === null || untouchable(request, response)) return response;
  const type = response.headers.get("content-type");
  // Checked before the body is touched: reading an SSE body would never end.
  if (isEventStream(type) || !compressible(type)) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.set("vary", mergeVary(headers.get("vary")));
  const init = { status: response.status, statusText: response.statusText, headers };
  if (bytes.byteLength < MIN_COMPRESS_BYTES) return new Response(bytes, init);
  let encoded: Uint8Array<ArrayBuffer>;
  try {
    encoded = await compress(bytes, encoding, DYNAMIC_BROTLI_QUALITY);
  } catch {
    return new Response(bytes, init);
  }
  headers.set("content-encoding", encoding);
  // The runtime sets the length of the encoded body; the old one is wrong now.
  headers.delete("content-length");
  return new Response(encoded, init);
}

/** Wraps a whole handler so every route's response is negotiated once. */
export function withCompression(
  handler: (request: Request) => Promise<Response>,
  compress: Compressor = zlibCompressor,
): (request: Request) => Promise<Response> {
  return async (request) => compressResponse(request, await handler(request), compress);
}

/**
 * Static assets are content-hashed and immutable, so each is compressed once
 * per encoding (at brotli's best quality, since it runs once) and kept in
 * memory. The Promise is cached so concurrent first requests share one run;
 * a failed run resolves to null and the asset is served uncompressed.
 */
export interface AssetCompressionCache {
  get(path: string, body: Uint8Array, encoding: Encoding): Promise<Uint8Array<ArrayBuffer> | null>;
}

export function createAssetCompressionCache(compress: Compressor = zlibCompressor): AssetCompressionCache {
  const cache = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>();
  return {
    get(path, body, encoding) {
      const key = `${encoding}:${path}`;
      let entry = cache.get(key);
      if (entry === undefined) {
        entry = Promise.resolve()
          .then(() => compress(body, encoding, constants.BROTLI_MAX_QUALITY))
          .catch(() => null);
        cache.set(key, entry);
      }
      return entry;
    },
  };
}
