import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  NestInterceptor,
  Query,
  Res,
} from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth, Public } from "../common/auth";
import {
  SLO_LATENCY_MS,
  SpanRecord,
  exportSpans,
  newSpanId,
  newTraceId,
  parseTraceparent,
  reportError,
  shouldSample,
  statusClass,
  telemetryStatus,
  templateRoute,
} from "../common/telemetry";

interface Bucket {
  minuteBucket: string;
  route: string;
  method: string;
  statusClass: string;
  count: number;
  totalMs: number;
  maxMs: number;
  breachCount: number;
}

/**
 * §12.2 Service-level metrics.
 *
 * Counts are aggregated in memory and flushed on a timer rather than written
 * per request: a hotel's own monitoring must not double its database write
 * volume. The flush is upsert-with-increment, so two API instances writing the
 * same minute add up instead of overwriting each other.
 */
@Injectable()
export class MetricsService {
  private buckets = new Map<string, Bucket>();
  /** Recent latencies per route, for percentiles between flushes. */
  private samples = new Map<string, number[]>();
  private timer?: NodeJS.Timeout;
  private static readonly MAX_SAMPLES = 500;

  constructor(private readonly prisma: PrismaService) {}

  private key(b: Omit<Bucket, "count" | "totalMs" | "maxMs" | "breachCount">) {
    return `${b.minuteBucket}|${b.route}|${b.method}|${b.statusClass}`;
  }

  record(route: string, method: string, status: number, durationMs: number) {
    const minuteBucket = new Date().toISOString().slice(0, 16);
    const cls = statusClass(status);
    const k = this.key({ minuteBucket, route, method, statusClass: cls });
    const existing =
      this.buckets.get(k) ??
      { minuteBucket, route, method, statusClass: cls, count: 0, totalMs: 0, maxMs: 0, breachCount: 0 };

    existing.count += 1;
    existing.totalMs += durationMs;
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    // 5xx responses are counted as breaches whatever their latency: a fast
    // failure is still a failure, and an availability SLI that ignores them
    // reports a healthy service while nothing works.
    if (durationMs > SLO_LATENCY_MS || cls === "5xx") existing.breachCount += 1;
    this.buckets.set(k, existing);

    const s = this.samples.get(route) ?? [];
    s.push(durationMs);
    if (s.length > MetricsService.MAX_SAMPLES) s.shift();
    this.samples.set(route, s);

    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 10_000);
      // A metrics flush must never hold the process open at shutdown.
      this.timer.unref?.();
    }
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = [...this.buckets.values()];
    this.buckets.clear();

    for (const b of pending) {
      try {
        await this.prisma.requestMetric.upsert({
          where: {
            minuteBucket_route_method_statusClass: {
              minuteBucket: b.minuteBucket,
              route: b.route,
              method: b.method,
              statusClass: b.statusClass,
            },
          },
          create: b,
          update: {
            count: { increment: b.count },
            totalMs: { increment: b.totalMs },
            breachCount: { increment: b.breachCount },
            maxMs: b.maxMs,
          },
        });
      } catch {
        // Losing a metrics row is acceptable; failing a request to record one
        // is not. Nothing here is allowed to throw into the request path.
      }
    }
    return pending.length;
  }

  percentiles(route: string) {
    const s = [...(this.samples.get(route) ?? [])].sort((a, b) => a - b);
    if (!s.length) return null;
    const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    return { count: s.length, p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1] };
  }

  /** The SLI an SLO is actually judged on, over a window of minutes. */
  async serviceLevel(windowMinutes = 60) {
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString().slice(0, 16);
    const rows = await this.prisma.requestMetric.findMany({
      where: { minuteBucket: { gte: since } },
    });

    const total = rows.reduce((s, r) => s + r.count, 0);
    const breaches = rows.reduce((s, r) => s + r.breachCount, 0);
    const errors = rows.filter((r) => r.statusClass === "5xx").reduce((s, r) => s + r.count, 0);
    const weightedMs = rows.reduce((s, r) => s + r.totalMs, 0);

    const byRoute = new Map<string, { count: number; totalMs: number; maxMs: number; errors: number }>();
    for (const r of rows) {
      const e = byRoute.get(r.route) ?? { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
      e.count += r.count;
      e.totalMs += r.totalMs;
      e.maxMs = Math.max(e.maxMs, r.maxMs);
      if (r.statusClass === "5xx") e.errors += r.count;
      byRoute.set(r.route, e);
    }

    return {
      windowMinutes,
      sloLatencyMs: SLO_LATENCY_MS,
      requests: total,
      // Stated as a percentage of requests that met the objective. An empty
      // window reports null, not 100% — no traffic is not the same as no
      // failures, and a dashboard that shows green for a dead service is worse
      // than one that shows nothing.
      availabilityPct: total ? Number((((total - errors) / total) * 100).toFixed(3)) : null,
      latencySloPct: total ? Number((((total - breaches) / total) * 100).toFixed(3)) : null,
      errorCount: errors,
      breachCount: breaches,
      meanMs: total ? Math.round(weightedMs / total) : null,
      slowestRoutes: [...byRoute.entries()]
        .map(([route, v]) => ({
          route,
          count: v.count,
          meanMs: Math.round(v.totalMs / v.count),
          maxMs: v.maxMs,
          errors: v.errors,
        }))
        .sort((a, b) => b.meanMs - a.meanMs)
        .slice(0, 10),
    };
  }

  /** Prometheus text exposition — what a scrape actually expects. */
  async prometheus() {
    await this.flush();
    const sl = await this.serviceLevel(60);
    const rows = await this.prisma.requestMetric.findMany({
      where: { minuteBucket: { gte: new Date(Date.now() - 3600_000).toISOString().slice(0, 16) } },
    });

    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const lines: string[] = [
      "# HELP lodgiva_http_requests_total Requests by route, method and status class.",
      "# TYPE lodgiva_http_requests_total counter",
    ];
    const totals = new Map<string, number>();
    const durations = new Map<string, number>();
    for (const r of rows) {
      const k = `route="${esc(r.route)}",method="${r.method}",status="${r.statusClass}"`;
      totals.set(k, (totals.get(k) ?? 0) + r.count);
      const dk = `route="${esc(r.route)}",method="${r.method}"`;
      durations.set(dk, (durations.get(dk) ?? 0) + r.totalMs);
    }
    for (const [k, v] of totals) lines.push(`lodgiva_http_requests_total{${k}} ${v}`);

    lines.push(
      "# HELP lodgiva_http_request_duration_ms_sum Total request time by route.",
      "# TYPE lodgiva_http_request_duration_ms_sum counter"
    );
    for (const [k, v] of durations) lines.push(`lodgiva_http_request_duration_ms_sum{${k}} ${v}`);

    lines.push(
      "# HELP lodgiva_slo_latency_ratio Share of requests inside the latency objective, last hour.",
      "# TYPE lodgiva_slo_latency_ratio gauge",
      `lodgiva_slo_latency_ratio ${sl.latencySloPct === null ? "NaN" : sl.latencySloPct / 100}`,
      "# HELP lodgiva_slo_availability_ratio Share of non-5xx requests, last hour.",
      "# TYPE lodgiva_slo_availability_ratio gauge",
      `lodgiva_slo_availability_ratio ${sl.availabilityPct === null ? "NaN" : sl.availabilityPct / 100}`
    );
    return `${lines.join("\n")}\n`;
  }
}

/**
 * One span per request, plus the metrics recording. Runs on every route, so it
 * is written to be cheap and to never throw: an interceptor that fails takes
 * the whole API with it.
 */
@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{
      method: string;
      url: string;
      headers: Record<string, string>;
      auth?: AuthContext;
      traceId?: string;
    }>();
    const res = http.getResponse<{ statusCode: number; header?: (k: string, v: string) => void }>();

    const parent = parseTraceparent(req.headers?.traceparent);
    const traceId = parent?.traceId ?? newTraceId();
    const spanId = newSpanId();
    req.traceId = traceId;
    // Echoed so a client can quote it in a support ticket and land on the
    // exact request.
    res.header?.("x-trace-id", traceId);

    const startMs = Date.now();
    const route = templateRoute(req.url ?? "/");

    const finish = (status: number, error?: Error) => {
      const endMs = Date.now();
      try {
        this.metrics.record(route, req.method, status, endMs - startMs);
      } catch {
        /* metrics must never break a request */
      }

      const span: SpanRecord = {
        traceId,
        spanId,
        name: `${req.method} ${route}`,
        startMs,
        endMs,
        status: status >= 500 ? "ERROR" : "OK",
        attributes: {
          "http.method": req.method,
          "http.route": route,
          "http.status_code": status,
          ...(req.auth?.tenantId ? { "lodgiva.tenant_id": req.auth.tenantId } : {}),
          ...(req.auth?.role ? { "lodgiva.role": req.auth.role } : {}),
        },
      };
      if (shouldSample(span.status)) void exportSpans([span], parent?.spanId);
      if (error && status >= 500) {
        void reportError({
          error,
          traceId,
          request: { method: req.method, url: req.url, headers: req.headers },
          user: { id: req.auth?.userId, tenantId: req.auth?.tenantId, role: req.auth?.role },
          tags: { route },
        });
      }
    };

    return next.handle().pipe(
      tap({
        next: () => finish(res.statusCode ?? 200),
        error: (err: Error & { status?: number; getStatus?: () => number }) => {
          const status = err.getStatus?.() ?? err.status ?? 500;
          finish(status, err);
        },
      })
    );
  }
}

@Controller()
export class ObservabilityController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Public because a Prometheus scraper has no session. In production this is
   * reached only from inside the network — see the WAF guidance in
   * docs/operations.md, which blocks it at the edge.
   */
  @Public()
  @Get("metrics")
  async prometheus(
    @Res() reply: { header: (k: string, v: string) => void; send: (b: string) => void }
  ) {
    const body = await this.metrics.prometheus();
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    reply.send(body);
  }

  @Get("observability/service-level")
  serviceLevel(@CurrentAuth() _auth: AuthContext, @Query("windowMinutes") w?: string) {
    return this.metrics.serviceLevel(Math.min(1440, Math.max(1, Number(w ?? 60))));
  }

  /** States exactly which exporters are live, so nobody assumes. */
  @Get("observability/status")
  status(@CurrentAuth() _auth: AuthContext) {
    return telemetryStatus();
  }
}

@Module({
  controllers: [ObservabilityController],
  providers: [MetricsService, TelemetryInterceptor],
  exports: [MetricsService, TelemetryInterceptor],
})
export class ObservabilityModule {}
