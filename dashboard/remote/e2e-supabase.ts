/**
 * A stand-in for `@supabase/supabase-js` in the bridge process the end-to-end
 * test spawns (`e2e.test.ts`), loaded with `bun --preload`:
 *
 *   bun --preload ./dashboard/remote/e2e-supabase.ts dashboard/remote/bridge.ts
 *
 * It replaces the package before `wake.ts` imports it, so the bridge, its
 * `supabaseTransport` and `startWake` all run unchanged. The client it hands
 * out speaks plain HTTP to the test's fake hub at `SUPABASE_URL`:
 *
 * - **Auth**: `signInWithPassword` is `POST /auth/v1/token?grant_type=password`
 *   with the key as `apikey`, answering an access token or an error.
 * - **Realtime**: a channel's `subscribe` opens `GET /realtime/v1/broadcast`
 *   with the topic, its `private` flag and the token, and reports `SUBSCRIBED`
 *   once the hub answers. The hub streams one JSON line per broadcast,
 *   `{ event, payload }`, handed to the channel's `broadcast` handlers as
 *   supabase-js does. A stream that ends reports `CLOSED`; a refused one,
 *   `CHANNEL_ERROR`.
 *
 * Only what `wake.ts` calls exists. Nothing here is loaded outside that test.
 */
import { plugin } from "bun";

type Broadcast = { type: "broadcast"; event: string; payload: unknown };
type SubscribeCallback = (status: string, error?: Error) => void;

interface FakeChannel {
  on(type: string, filter: { event: string }, handler: (message: Broadcast) => void): FakeChannel;
  subscribe(callback: SubscribeCallback): FakeChannel;
  /** Stop the stream without reporting it. */
  abort(): void;
}

function createClient(url: string, key: string) {
  const base = url.replace(/\/+$/, "");
  let token: string | null = null;

  const channel = (topic: string, options: { config?: { private?: boolean } } = {}): FakeChannel => {
    const handlers = new Map<string, (message: Broadcast) => void>();
    const stop = new AbortController();
    const self: FakeChannel = {
      on(type, filter, handler) {
        if (type === "broadcast") handlers.set(filter.event, handler);
        return self;
      },
      subscribe(callback) {
        void (async () => {
          const query = new URLSearchParams({ topic, private: String(options.config?.private === true) });
          let response: Response;
          try {
            response = await fetch(`${base}/realtime/v1/broadcast?${query}`, {
              headers: { apikey: key, authorization: `Bearer ${token ?? ""}` },
              signal: stop.signal,
            });
          } catch (error) {
            if (!stop.signal.aborted) callback("CHANNEL_ERROR", error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (!response.ok || response.body === null) {
            callback("CHANNEL_ERROR", new Error(`realtime answered HTTP ${response.status}`));
            return;
          }
          callback("SUBSCRIBED");
          const decoder = new TextDecoder();
          let buffered = "";
          try {
            for await (const bytes of response.body) {
              buffered += decoder.decode(bytes, { stream: true });
              for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
                const line = buffered.slice(0, end);
                buffered = buffered.slice(end + 1);
                if (line.trim() === "") continue;
                const { event, payload } = JSON.parse(line) as { event: string; payload: unknown };
                handlers.get(event)?.({ type: "broadcast", event, payload });
              }
            }
          } catch {
            // The stream broke; reported below like an end.
          }
          if (!stop.signal.aborted) callback("CLOSED");
        })();
        return self;
      },
      abort: () => stop.abort(),
    };
    return self;
  };

  return {
    auth: {
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const response = await fetch(`${base}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: key, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const body = (await response.json()) as { access_token?: string; error_description?: string };
        if (!response.ok || body.access_token === undefined) {
          return { data: { session: null, user: null }, error: { message: body.error_description ?? `HTTP ${response.status}` } };
        }
        token = body.access_token;
        return { data: { session: { access_token: body.access_token }, user: null }, error: null };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signOut() {
        token = null;
        return { error: null };
      },
    },
    realtime: {
      setAuth(next: string) {
        token = next;
      },
    },
    channel,
    async removeChannel(target: FakeChannel) {
      target.abort();
      return "ok";
    },
  };
}

plugin({
  name: "e2e-supabase",
  setup(build) {
    build.module("@supabase/supabase-js", () => ({ exports: { createClient }, loader: "object" }));
  },
});
