/**
 * §12.2 Observability: tracing, error reporting and service-level metrics.
 *
 * Both exporters speak their vendors' wire protocols directly over HTTP —
 * OTLP/JSON for traces, the Sentry store envelope for errors — rather than
 * pulling in two large SDKs to send a handful of JSON documents. That keeps
 * the dependency surface of a hotel PMS small and makes the payloads
 * inspectable in a test.
 *
 * IMPORTANT, and stated plainly because it is easy to mistake for working:
 * with no OTEL_EXPORTER_OTLP_ENDPOINT and no SENTRY_DSN configured, both
 * exporters are inert. Spans are still recorded and sampled in-process (and
 * are readable through /health/metrics), but nothing is transmitted. No span
 * has been delivered to a real collector, and no event to a real Sentry
 * project, from this environment.
 */
import { randomBytes } from "node:crypto";

export interface SpanRecord {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  endMs: number;
  status: "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>;
}

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "lodgiva-api";
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const SENTRY_DSN = process.env.SENTRY_DSN;
const ENVIRONMENT = process.env.NODE_ENV ?? "development";
const RELEASE = process.env.APP_RELEASE ?? "dev";

/**
 * Head sampling. Traces are for finding the shape of a problem, not for
 * counting — the counting is done by the metrics recorder, which sees every
 * request. Errors are always sampled: a 1% chance of capturing the one trace
 * that explains an outage is not a trade worth making.
 */
const SAMPLE_RATE = Number(process.env.OTEL_SAMPLE_RATE ?? 0.1);

export const telemetryStatus = () => ({
  service: SERVICE_NAME,
  environment: ENVIRONMENT,
  release: RELEASE,
  tracing: {
    configured: !!OTLP_ENDPOINT,
    endpoint: OTLP_ENDPOINT ?? null,
    sampleRate: SAMPLE_RATE,
    reason: OTLP_ENDPOINT
      ? null
      : "OTEL_EXPORTER_OTLP_ENDPOINT is not set: spans are recorded in-process but not exported.",
  },
  errorReporting: {
    configured: !!SENTRY_DSN,
    reason: SENTRY_DSN
      ? null
      : "SENTRY_DSN is not set: exceptions are logged locally but not reported.",
  },
});

export const newTraceId = () => randomBytes(16).toString("hex");
export const newSpanId = () => randomBytes(8).toString("hex");

/** W3C traceparent, so a trace started by a load balancer is continued here. */
export function parseTraceparent(header?: string): { traceId: string; spanId: string } | null {
  if (!header) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(header.trim());
  if (!m) return null;
  // All-zero ids are explicitly invalid in the spec and mean the caller has a
  // broken tracer; starting a fresh trace beats joining an impossible one.
  if (/^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], spanId: m[2] };
}

export function shouldSample(status: "OK" | "ERROR"): boolean {
  if (status === "ERROR") return true;
  return Math.random() < SAMPLE_RATE;
}

/** OTLP/JSON — the shape an OpenTelemetry collector accepts on /v1/traces. */
export function toOtlpPayload(spans: SpanRecord[], parentSpanId?: string) {
  const toNano = (ms: number) => String(Math.round(ms * 1e6));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: SERVICE_NAME } },
            { key: "deployment.environment", value: { stringValue: ENVIRONMENT } },
            { key: "service.version", value: { stringValue: RELEASE } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "lodgiva" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(parentSpanId ? { parentSpanId } : {}),
              name: s.name,
              kind: 2, // SPAN_KIND_SERVER
              startTimeUnixNano: toNano(s.startMs),
              endTimeUnixNano: toNano(s.endMs),
              attributes: Object.entries(s.attributes).map(([key, value]) => ({
                key,
                value:
                  typeof value === "number"
                    ? { intValue: String(Math.round(value)) }
                    : typeof value === "boolean"
                      ? { boolValue: value }
                      : { stringValue: String(value) },
              })),
              status: { code: s.status === "ERROR" ? 2 : 1 },
            })),
          },
        ],
      },
    ],
  };
}

export function parseSentryDsn(dsn: string) {
  // https://<publicKey>@<host>/<projectId>
  const m = /^(https?):\/\/([^@:]+)(?::[^@]*)?@([^/]+)\/(.+)$/.exec(dsn.trim());
  if (!m) return null;
  const [, protocol, publicKey, host, projectId] = m;
  return {
    publicKey,
    projectId,
    storeUrl: `${protocol}://${host}/api/${projectId}/store/`,
    authHeader:
      `Sentry sentry_version=7, sentry_client=lodgiva/1.0, sentry_key=${publicKey}`,
  };
}

/** Fields that must never leave the building inside an error report. */
const REDACT = /(password|secret|token|authorization|cookie|apikey|api_key|signature)/i;

export function buildSentryEvent(input: {
  error: Error;
  level?: "error" | "warning" | "fatal";
  request?: { method: string; url: string; headers?: Record<string, unknown> };
  user?: { id?: string; tenantId?: string; role?: string };
  traceId?: string;
  tags?: Record<string, string>;
}) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.request?.headers ?? {})) {
    headers[k] = REDACT.test(k) ? "[redacted]" : String(v);
  }
  return {
    event_id: randomBytes(16).toString("hex"),
    timestamp: new Date().toISOString(),
    platform: "node",
    level: input.level ?? "error",
    environment: ENVIRONMENT,
    release: RELEASE,
    server_name: SERVICE_NAME,
    // No email, no guest name: an error report is not a place for personal
    // data, and Sentry retention is not covered by the tenant's DPA.
    user: input.user ? { id: input.user.id, segment: input.user.role } : undefined,
    tags: { ...input.tags, ...(input.user?.tenantId ? { tenant: input.user.tenantId } : {}) },
    contexts: input.traceId ? { trace: { trace_id: input.traceId } } : undefined,
    request: input.request
      ? { method: input.request.method, url: stripQuery(input.request.url), headers }
      : undefined,
    exception: {
      values: [
        {
          type: input.error.name,
          value: input.error.message,
          stacktrace: { frames: parseStack(input.error) },
        },
      ],
    },
  };
}

/** Query strings carry references and tokens; the path is enough to debug. */
function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

function parseStack(error: Error) {
  return (error.stack ?? "")
    .split("\n")
    .slice(1, 21)
    .map((line) => {
      const m = /at (?:(.+?) )?\(?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
      if (!m) return { function: line.trim() };
      return {
        function: m[1] ?? "<anonymous>",
        filename: m[2],
        lineno: Number(m[3]),
        colno: Number(m[4]),
      };
    })
    .reverse(); // Sentry renders oldest frame first.
}

/**
 * Both exporters are fire-and-forget with a short timeout. A telemetry backend
 * having a bad day must never become the hotel's outage — the failure mode of
 * observability has to be "we lost visibility", never "we lost check-ins".
 */
async function post(url: string, body: unknown, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Deliberately swallowed. See above.
  } finally {
    clearTimeout(timer);
  }
}

export async function exportSpans(spans: SpanRecord[], parentSpanId?: string) {
  if (!OTLP_ENDPOINT || spans.length === 0) return false;
  await post(`${OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`, toOtlpPayload(spans, parentSpanId), {
    ...(process.env.OTEL_EXPORTER_OTLP_HEADERS ? parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS) : {}),
  });
  return true;
}

function parseOtlpHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (k && rest.length) out[k.trim()] = rest.join("=").trim();
  }
  return out;
}

export async function reportError(input: Parameters<typeof buildSentryEvent>[0]) {
  if (!SENTRY_DSN) return false;
  const dsn = parseSentryDsn(SENTRY_DSN);
  if (!dsn) return false;
  await post(dsn.storeUrl, buildSentryEvent(input), { "X-Sentry-Auth": dsn.authHeader });
  return true;
}

/**
 * Route templating. `/reservations/8f3c…` and `/reservations/1a2b…` are the
 * same route; recording them separately would produce a metric with one series
 * per reservation and no usable percentile.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIRMATION = /^LDG-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;

export function templateRoute(path: string): string {
  const clean = stripQuery(path);
  return (
    clean
      .split("/")
      .map((seg) => {
        if (!seg) return seg;
        if (UUID.test(seg)) return ":id";
        if (CONFIRMATION.test(seg)) return ":code";
        if (/^\d+$/.test(seg)) return ":n";
        // Long opaque strings are almost always ids of some kind.
        if (seg.length > 24 && !seg.includes(".")) return ":id";
        return seg;
      })
      .join("/") || "/"
  );
}

export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/** The latency objective every route is measured against (§12.2). */
export const SLO_LATENCY_MS = Number(process.env.SLO_LATENCY_MS ?? 500);
