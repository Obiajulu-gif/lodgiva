import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeProductionEnvironment } from "../../dist/common/runtime-config.js";

const valid = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:secret@db.example.invalid:5432/lodgiva?sslmode=require",
  JWT_SECRET: "j".repeat(64),
  CORS_ORIGINS: "https://dashboard.example.invalid,https://admin.example.invalid",
  STORAGE_SIGNING_KEY: "s".repeat(64),
  STORAGE_BASE_URL: "https://api.example.invalid/api/v1/files",
};

test("development may use local defaults", () => {
  assert.doesNotThrow(() => assertSafeProductionEnvironment({ NODE_ENV: "development" }));
});

test("a complete production environment passes", () => {
  assert.doesNotThrow(() => assertSafeProductionEnvironment(valid));
});

test("production fails closed when required values are absent", () => {
  assert.throws(
    () => assertSafeProductionEnvironment({ NODE_ENV: "production" }),
    (error) => {
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /JWT_SECRET/);
      assert.match(error.message, /CORS_ORIGINS/);
      assert.match(error.message, /STORAGE_SIGNING_KEY/);
      assert.match(error.message, /STORAGE_BASE_URL/);
      return true;
    }
  );
});

test("known defaults, SQLite, wildcard CORS and HTTP storage are rejected", () => {
  assert.throws(
    () =>
      assertSafeProductionEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "file:./dev.db",
        JWT_SECRET: "lodgiva-dev-secret-change-in-production",
        CORS_ORIGINS: "*",
        STORAGE_SIGNING_KEY: "lodgiva-dev-storage-signing-key",
        STORAGE_BASE_URL: "http://localhost:4000/api/v1/files",
      }),
    /Unsafe production configuration/
  );
});

test("CORS accepts origins only, not paths or embedded credentials", () => {
  for (const origin of [
    "https://dashboard.example.invalid/path",
    "https://user:pass@dashboard.example.invalid",
    "http://dashboard.example.invalid",
  ]) {
    assert.throws(
      () => assertSafeProductionEnvironment({ ...valid, CORS_ORIGINS: origin }),
      /CORS_ORIGINS/
    );
  }
});

