const DEVELOPMENT_JWT_SECRET = "lodgiva-dev-secret-change-in-production";
const DEVELOPMENT_STORAGE_SECRET = "lodgiva-dev-storage-signing-key";

function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Refuse an accidentally unsafe production process before Nest, Prisma, or a
 * listener starts. This deliberately validates only settings the current
 * runtime consumes; future R2/Redis/provider adapters must extend this gate.
 */
export function assertSafeProductionEnvironment(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.NODE_ENV !== "production") return;

  const issues: string[] = [];
  if (!/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL ?? "")) {
    issues.push("DATABASE_URL must be an explicit PostgreSQL URL");
  }

  const jwt = env.JWT_SECRET ?? "";
  if (jwt.length < 32 || jwt === DEVELOPMENT_JWT_SECRET) {
    issues.push("JWT_SECRET must be a non-default secret of at least 32 characters");
  }

  const origins = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0 || origins.some((origin) => origin === "*" || !exactHttpsOrigin(origin))) {
    issues.push("CORS_ORIGINS must contain exact comma-separated HTTPS origins");
  }

  const storageSecret = env.STORAGE_SIGNING_KEY ?? "";
  if (storageSecret.length < 32 || storageSecret === DEVELOPMENT_STORAGE_SECRET) {
    issues.push("STORAGE_SIGNING_KEY must be a non-default secret of at least 32 characters");
  }
  if (!/^https:\/\//i.test(env.STORAGE_BASE_URL ?? "")) {
    issues.push("STORAGE_BASE_URL must be an explicit HTTPS URL");
  }
  if ((env.STORAGE_ADAPTER ?? "").toLowerCase() !== "r2") {
    issues.push("STORAGE_ADAPTER must be r2 in production");
  }
  for (const name of [
    "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
    "R2_PUBLIC_BUCKET", "R2_PRIVATE_BUCKET", "R2_PUBLIC_BASE_URL",
  ]) {
    if (!env[name]) issues.push(`${name} is required for production storage`);
  }

  const mfaKey = Buffer.from(env.MFA_ENCRYPTION_KEY ?? "", "base64");
  if (mfaKey.length !== 32) {
    issues.push("MFA_ENCRYPTION_KEY must be 32 random bytes encoded as base64");
  }

  if (issues.length > 0) {
    throw new Error(`Unsafe production configuration:\n- ${issues.join("\n- ")}`);
  }
}
