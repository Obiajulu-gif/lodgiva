/**
 * Generates a typed API client from docs/openapi.json.
 *
 * Written as a small generator rather than pulling in a heavyweight codegen
 * dependency: the document is produced from decorators (paths, methods,
 * parameters, security) and that is exactly what this emits. Request body
 * shapes are validated with Zod at runtime and are therefore NOT present in
 * the OpenAPI document — see docs/api-reference.md. Bodies are typed as
 * `unknown` here rather than pretending to a precision the spec does not
 * carry.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const specPath = resolve(root, "docs/openapi.json");
const outPath = resolve(root, "packages/api-client/src/index.ts");

const spec = JSON.parse(readFileSync(specPath, "utf8"));

const camel = (s) =>
  s
    .replace(/[{}]/g, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");

const operations = [];
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    const params = [...(path.matchAll(/\{(\w+)\}/g))].map((m) => m[1]);
    const query = (op.parameters ?? [])
      .filter((p) => p.in === "query")
      .map((p) => ({ name: p.name, required: !!p.required }));
    const base = op.operationId ? camel(op.operationId) : camel(`${method}_${path}`);
    operations.push({ path, method: method.toUpperCase(), name: base, params, query, tags: op.tags ?? [] });
  }
}

// Disambiguate any duplicate method names.
const seen = new Map();
for (const op of operations) {
  const n = seen.get(op.name) ?? 0;
  seen.set(op.name, n + 1);
  if (n > 0) op.name = `${op.name}${n + 1}`;
}

const header = `/* AUTO-GENERATED from docs/openapi.json — do not edit by hand.
 * Regenerate with: pnpm --filter @lodgiva/database generate:client
 *
 * Request bodies are typed as \`unknown\`: the API validates them with Zod at
 * runtime, so the OpenAPI document does not describe body schemas. See
 * docs/api-reference.md for the body contracts.
 */

export interface LodgivaClientOptions {
  baseUrl?: string;
  /** Called before each request; return the current access token. */
  getToken?: () => string | null | undefined;
  fetch?: typeof globalThis.fetch;
}

export class LodgivaApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "LodgivaApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class LodgivaClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null | undefined;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: LodgivaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\\/$/, "");
    this.getToken = options.getToken ?? (() => null);
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(this.baseUrl + path, this.baseUrl || "http://localhost");
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const token = this.getToken();
    const res = await this.doFetch(this.baseUrl ? url.toString() : url.pathname + url.search, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: \`Bearer \${token}\` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
      throw new LodgivaApiError(
        err?.code ?? "UNKNOWN",
        err?.message ?? \`Request failed with \${res.status}\`,
        res.status,
        err?.details
      );
    }
    return data as T;
  }
`;

const methods = operations
  .map((op) => {
    const pathParams = op.params.map((p) => `${p}: string`);
    const hasQuery = op.query.length > 0;
    const hasBody = ["POST", "PATCH", "PUT"].includes(op.method);
    const args = [
      ...pathParams,
      ...(hasBody ? ["body?: unknown"] : []),
      ...(hasQuery
        ? [`query?: { ${op.query.map((q) => `${q.name}?: string | number | boolean`).join("; ")} }`]
        : []),
    ].join(", ");
    const template = op.path.replace(/\{(\w+)\}/g, (_m, p) => `\${${p}}`);
    const opts = [hasQuery ? "query" : null, hasBody ? "body" : null].filter(Boolean).join(", ");
    const tag = op.tags[0] ? ` (${op.tags[0]})` : "";
    return `
  /** ${op.method} ${op.path}${tag} */
  ${op.name}<T = unknown>(${args}): Promise<T> {
    return this.request<T>("${op.method}", \`${template}\`${opts ? `, { ${opts} }` : ""});
  }`;
  })
  .join("\n");

const output = `${header}${methods}\n}\n\nexport default LodgivaClient;\n`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, output);
console.log(
  `Generated ${operations.length} operations from ${Object.keys(spec.paths).length} paths → ${outPath}`
);
