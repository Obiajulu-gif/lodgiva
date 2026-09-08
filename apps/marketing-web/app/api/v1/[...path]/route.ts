import { createApiApp } from "@lodgiva/api";

// Inferred rather than imported: the Nest types live in the API package's
// own dependency tree, which this app deliberately does not depend on.
type ApiApp = Awaited<ReturnType<typeof createApiApp>>;

/**
 * The entire Lodgiva API, served from a Next.js route handler.
 *
 * This does NOT reimplement the backend. It boots the real NestJS application
 * — all 29 modules, the same guards, the same rate limits, the same audit
 * trail — and dispatches each incoming Web Request into it through Fastify's
 * `inject()`. Rewriting 17,000 lines of ledger, tenancy and auth logic as
 * route handlers would have produced a second implementation to keep in sync,
 * and the first thing to drift silently would have been something that moves
 * money.
 *
 * Node runtime, never Edge: Argon2 and the Prisma engine are native modules.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One boot per warm instance. The promise (not the resolved app) is cached so
 * that concurrent first requests share a single boot instead of racing to
 * build 29 modules and open 29 connection pools.
 */
let appPromise: Promise<ApiApp> | null = null;

function getApp(): Promise<ApiApp> {
  if (!appPromise) {
    appPromise = createApiApp().catch((cause) => {
      // A failed boot must not be cached, or one transient database blip
      // during a cold start would poison this instance until it recycles.
      appPromise = null;
      throw cause;
    });
  }
  return appPromise;
}

/**
 * Hop-by-hop headers describe one connection, not the payload. Forwarding them
 * into a synthetic request makes Fastify believe things about a socket that
 * does not exist here.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length", // inject recomputes it from the payload
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length", // Response sets this from the body itself
]);

/**
 * The client's real address.
 *
 * This is not cosmetic. Every rate limit in the API is keyed by `req.ip`, and
 * `inject()` defaults to 127.0.0.1 — so without this, every visitor on earth
 * would share one bucket and the 30/minute login budget would lock the whole
 * internet out after thirty attempts. The leftmost entry of x-forwarded-for is
 * the client; Vercel appends the real address and we are behind it, so the
 * header cannot be spoofed past the platform.
 */
function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? "127.0.0.1";
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Server-Sent Events cannot survive this transport: inject() buffers a
  // complete response, so a stream that never ends would hold the function
  // open until it times out and then return nothing. Say so plainly instead of
  // hanging. The Next dashboard polls (refetchInterval) and does not use this;
  // the Vite staff app does, and needs the standalone server.
  if (url.pathname.includes("/events/")) {
    return Response.json(
      {
        error: {
          code: "SSE_UNAVAILABLE",
          message:
            "Live event streams need the long-running server; this deployment is serverless. Poll the resource instead.",
          retryable: false,
        },
      },
      { status: 501 },
    );
  }

  let app: ApiApp;
  try {
    app = await getApp();
  } catch (cause) {
    // Boot failures are configuration problems (a missing secret, an
    // unreachable database). Report them as such rather than as a generic 500
    // that sends someone reading application logs for an hour.
    return Response.json(
      {
        error: {
          code: "API_UNAVAILABLE",
          message:
            cause instanceof Error ? cause.message : "The API failed to start.",
          retryable: true,
        },
      },
      { status: 503 },
    );
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });

  // The raw bytes, untouched. Payment webhooks verify an HMAC computed over
  // exactly what the provider sent, so re-serialising the parsed JSON here
  // would change key order and whitespace and invalidate every signature.
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : Buffer.from(await request.arrayBuffer());

  const result = await app.getHttpAdapter().getInstance().inject({
    method: request.method as "GET",
    url: `${url.pathname}${url.search}`,
    headers,
    payload: body,
    remoteAddress: clientAddress(request.headers),
  });

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(result.headers)) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    // Set-Cookie arrives as an array when more than one cookie is set, and
    // collapsing it into a comma-joined string silently drops the session
    // cookie's attributes. Each one has to be appended separately.
    if (Array.isArray(value)) {
      for (const entry of value) responseHeaders.append(key, String(entry));
    } else if (value !== undefined) {
      responseHeaders.set(key, String(value));
    }
  }

  return new Response(
    result.statusCode === 204 || result.statusCode === 304
      ? null
      : result.rawPayload,
    { status: result.statusCode, headers: responseHeaders },
  );
}

export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as HEAD,
  handle as OPTIONS,
};
