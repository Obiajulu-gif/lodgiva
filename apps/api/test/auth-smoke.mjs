/*
 * Full authentication smoke test against a running API and disposable rows.
 *
 * Requires DATABASE_URL and defaults to http://127.0.0.1:4000/api/v1.
 * Every database row created by this test is removed in the finally block.
 */
import { createHmac, randomUUID } from "node:crypto";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const base = process.env.AUTH_SMOKE_BASE_URL ?? "http://127.0.0.1:4000/api/v1";
const suffix = randomUUID();
const email = `auth-smoke-${suffix}@lodgiva.test`;
const password = "AuthSmoke-Password-92!";
let tenant;
let property;
let user;

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function request(path, { body, token, cookie } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    data,
    setCookie,
    cookie: setCookie?.split(";", 1)[0],
  };
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("MFA setup returned an invalid base32 secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function currentTotp(secret) {
  const counter = Math.floor(Date.now() / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

async function main() {
  try {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    tenant = await prisma.tenant.create({
      data: {
        legalName: "Authentication Smoke Test",
        displayName: "Authentication Smoke Test",
        slug: `auth-smoke-${suffix}`,
        mfaRequiredRoles: '["TENANT_OWNER"]',
      },
    });
    property = await prisma.property.create({
      data: {
        tenantId: tenant.id,
        name: "Authentication Test Property",
        code: "AUTH",
        slug: `auth-${suffix}`,
        businessDate: new Date().toISOString().slice(0, 10),
      },
    });
    user = await prisma.user.create({
      data: { email, fullName: "Authentication Test User", passwordHash },
    });
    await prisma.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "TENANT_OWNER" },
    });

    const wrong = await request("/auth/login", {
      body: { email, password: "wrong-password" },
    });
    assert(
      wrong.status === 401 && wrong.data.error?.code === "INVALID_CREDENTIALS",
      "wrong password was not rejected"
    );

    const login = await request("/auth/login", {
      body: { email: `  ${email.toUpperCase()}  `, password },
    });
    assert(
      login.status === 201 && login.data.status === "MFA_ENROLMENT_REQUIRED",
      "normalized login did not require MFA enrollment"
    );
    assert(
      !login.data.accessToken && !login.data.refreshToken && !login.setCookie,
      "pre-MFA login leaked a session"
    );

    const setup = await request("/auth/mfa/enrol/setup", {
      body: { setupToken: login.data.setupToken },
    });
    assert(
      setup.status === 201 && setup.data.secret && setup.data.otpauthUri,
      "MFA setup failed"
    );

    const badCode = await request("/auth/mfa/enrol/activate", {
      body: { setupToken: login.data.setupToken, code: "000000" },
    });
    assert(
      badCode.status === 401 && badCode.data.error?.code === "INVALID_MFA_CODE",
      "invalid MFA code was not rejected"
    );

    const activated = await request("/auth/mfa/enrol/activate", {
      body: {
        setupToken: login.data.setupToken,
        code: currentTotp(setup.data.secret),
      },
    });
    assert(
      activated.status === 201 &&
        activated.data.accessToken &&
        activated.data.recoveryCodes?.length > 0,
      "MFA activation did not create a session"
    );
    assert(!activated.data.refreshToken, "refresh token leaked into JSON");
    assert(
      activated.setCookie?.toLowerCase().includes("httponly") &&
        activated.setCookie?.toLowerCase().includes("samesite=strict"),
      "refresh cookie flags are missing"
    );

    const me = await request("/auth/me", { token: activated.data.accessToken });
    assert(
      me.status === 200 && me.data.user?.email === email,
      "authenticated profile failed"
    );

    const refreshed = await request("/auth/refresh", {
      body: {},
      cookie: activated.cookie,
    });
    assert(
      refreshed.status === 201 && refreshed.data.accessToken && refreshed.cookie,
      "refresh failed"
    );
    assert(
      !refreshed.data.refreshToken && refreshed.cookie !== activated.cookie,
      "refresh token did not rotate safely"
    );

    const oldAccess = await request("/auth/me", {
      token: activated.data.accessToken,
    });
    assert(oldAccess.status === 401, "access token from rotated session remained active");
    const newAccess = await request("/auth/me", {
      token: refreshed.data.accessToken,
    });
    assert(newAccess.status === 200, "new access token was rejected");

    const logout = await request("/auth/logout", {
      body: {},
      token: refreshed.data.accessToken,
      cookie: refreshed.cookie,
    });
    assert(logout.status === 201 && logout.data.ok === true, "logout failed");
    const afterLogout = await request("/auth/refresh", {
      body: {},
      cookie: refreshed.cookie,
    });
    assert(afterLogout.status === 401, "logged-out refresh session remained active");
    const revokedAccess = await request("/auth/me", {
      token: refreshed.data.accessToken,
    });
    assert(revokedAccess.status === 401, "logged-out access session remained active");

    const returningLogin = await request("/auth/login", {
      body: { email, password },
    });
    assert(
      returningLogin.status === 201 &&
        returningLogin.data.status === "MFA_REQUIRED" &&
        !returningLogin.data.accessToken &&
        !returningLogin.setCookie,
      "an enrolled user bypassed the MFA challenge"
    );
    const rejectedMfa = await request("/auth/mfa/verify", {
      body: { mfaToken: returningLogin.data.mfaToken, code: "000000" },
    });
    assert(
      rejectedMfa.status === 401 && rejectedMfa.data.error?.code === "INVALID_MFA_CODE",
      "an invalid returning-user MFA code was not rejected"
    );
    const verifiedMfa = await request("/auth/mfa/verify", {
      body: {
        mfaToken: returningLogin.data.mfaToken,
        code: currentTotp(setup.data.secret),
      },
    });
    assert(
      verifiedMfa.status === 201 && verifiedMfa.data.accessToken && verifiedMfa.cookie,
      "a valid returning-user MFA code did not create a session"
    );
    await request("/auth/logout", {
      body: {},
      token: verifiedMfa.data.accessToken,
      cookie: verifiedMfa.cookie,
    });

    console.log(
      "Authentication smoke test passed: invalid password, email normalization, " +
        "MFA enrollment and challenge, secure refresh cookie, rotation, and logout revocation."
    );
  } finally {
    if (user) await prisma.session.deleteMany({ where: { userId: user.id } });
    if (tenant && user) {
      await prisma.membership.deleteMany({
        where: { tenantId: tenant.id, userId: user.id },
      });
    }
    if (property) {
      await prisma.property.delete({ where: { id: property.id } }).catch(() => {});
    }
    if (tenant) {
      await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
    }
    if (user) {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
