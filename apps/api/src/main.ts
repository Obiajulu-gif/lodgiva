import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { HttpException } from "@nestjs/common";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { buildOpenApiDocument, mountSwagger } from "./openapi";

// SQLite database lives next to the Prisma schema (see ADR-LOCAL-001).
process.env.DATABASE_URL ??= "file:./dev.db";
process.env.JWT_SECRET ??= "lodgiva-dev-secret-change-in-production";

// Money is BigInt minor units (§7.3); serialize as number for JSON responses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  const adapter = new FastifyAdapter();

  // Action endpoints such as /no-show and /approve carry no payload. Fastify
  // rejects an empty body when Content-Type is application/json, so register
  // our own parser (with Nest's disabled below) that treats it as {}.
  adapter.getInstance().addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (
      req: unknown,
      body: Buffer,
      done: (err: Error | null, result?: unknown) => void
    ) => {
      // Webhook signatures are computed over the exact bytes the provider
      // sent. Re-serialising the parsed object changes whitespace and key
      // order, so the raw buffer is stashed on the request and the JSON is
      // parsed from it separately.
      (req as { rawBody?: Buffer }).rawBody = body;
      const text = body.toString("utf8");
      if (!text.trim()) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error);
      }
    }
  );

  // Binary bodies (presigned file uploads). Without a parser for these types
  // Fastify answers 415 before the route is ever reached. The buffer is left
  // untouched — it is the payload, not something to interpret.
  adapter.getInstance().addContentTypeParser(
    /^(image|application|text)\/(?!json).*/,
    { parseAs: "buffer" },
    (req: unknown, body: Buffer, done: (err: Error | null, result?: unknown) => void) => {
      (req as { rawBody?: Buffer }).rawBody = body;
      done(null, body);
    }
  );

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bodyParser: false, // our parser above is the only JSON parser
  });
  app.setGlobalPrefix("api/v1");

  // §12.1 security baseline.
  await app.register(require("@fastify/helmet"), {
    // The API serves JSON only; a restrictive CSP costs nothing here.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  });
  await app.register(require("@fastify/cors"), {
    origin: process.env.CORS_ORIGINS?.split(",") ?? true,
    credentials: true,
  });
  const rateLimitKey = (req: { headers: Record<string, string | undefined>; ip: string }) =>
    req.headers.authorization ? `t:${req.headers.authorization.slice(-32)}` : `ip:${req.ip}`;
  /**
   * An HttpException, not a plain object.
   *
   * @fastify/rate-limit throws whatever this builder returns, and Nest owns the
   * error handler here — anything that is not an HttpException becomes a 500.
   * A rate limit that reports itself as a server fault teaches every client to
   * retry harder, which is precisely the opposite of what it exists to do. The
   * e2e suite asserts the 429 by actually exhausting the budget, because the
   * plain-object version passed every header check while still answering 500.
   */
  const rateLimitBody = (message: string) => ({
    error: { code: "RATE_LIMITED", message, retryable: true },
  });
  const rateLimitError = (_req: unknown, ctx: { after: string }) =>
    new HttpException(rateLimitBody(`Too many requests. Retry after ${ctx.after}.`), 429);

  /**
   * §12.1 — the global allowance is sized for a busy front desk, which makes
   * it useless against credential stuffing: 600 password guesses a minute is a
   * working attack. Unauthenticated auth routes get their own much tighter
   * budget, keyed by IP because there is no session yet to key on.
   *
   * Registered BEFORE the plugin: @fastify/rate-limit installs its own
   * onRoute hook that reads `config.rateLimit` when the route is added, and
   * Fastify runs hooks in registration order. Adding ours afterwards set the
   * config a moment too late and every auth route quietly kept the global
   * 600/minute budget - which the integration test caught by comparing the
   * advertised x-ratelimit-limit values.
   *
   * This is defence in depth, not the whole defence: per-account progressive
   * lockout lives in AuthService, and the edge WAF rules in docs/operations.md
   * are what stop a distributed attempt that spreads itself across addresses.
   */
  // 30/minute per IP. Tight enough that credential stuffing is throttled to
  // uselessness, loose enough that a hotel behind one NAT'd address can put a
  // whole shift through the login screen at 07:00 without locking itself out
  // of its own front desk. The real defence against guessing ONE account is
  // the per-account progressive lockout in AuthService; this limit exists to
  // cap volume, and the edge WAF rules in docs/operations.md handle an attempt
  // spread across many addresses.
  const authLimit = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30);
  const strictRoutes = new Set([
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/auth/mfa/verify",
    "/api/v1/auth/mfa/enrol/activate",
    "/api/v1/onboarding/invitations/accept",
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter.getInstance().addHook("onRoute", (route: any) => {
    if (!strictRoutes.has(route.path)) return;
    route.config = {
      ...(route.config ?? {}),
      rateLimit: {
        max: authLimit,
        timeWindow: "1 minute",
        keyGenerator: (req: { ip: string }) => `auth:${req.ip}`,
        errorResponseBuilder: (_req: unknown, ctx: { after: string }) =>
          new HttpException(
            rateLimitBody(`Too many sign-in attempts. Retry after ${ctx.after}.`),
            429
          ),
      },
    };
  });
  await app.register(require("@fastify/rate-limit"), {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 600),
    timeWindow: "1 minute",
    // Per authenticated user where possible, otherwise per IP, so one busy
    // property cannot exhaust another tenant's allowance.
    keyGenerator: rateLimitKey,
    errorResponseBuilder: rateLimitError,
  });

  // OpenAPI: served at /api/v1/docs and written to disk for client generation.
  const document = buildOpenApiDocument(app);
  mountSwagger(app, document);
  if (process.env.OPENAPI_OUT) {
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    mkdirSync(dirname(process.env.OPENAPI_OUT), { recursive: true });
    writeFileSync(process.env.OPENAPI_OUT, JSON.stringify(document, null, 2));
    console.log(`OpenAPI written to ${process.env.OPENAPI_OUT}`);
    if (process.env.OPENAPI_EXIT === "1") {
      await app.close();
      return;
    }
  }

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
  console.log(`Lodgiva API listening on http://localhost:${port}/api/v1`);
}

bootstrap();
