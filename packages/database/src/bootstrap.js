/* One-time production bootstrap. No sample data or default credentials. */
const { PrismaClient } = require("@prisma/client");
const argon2 = require("argon2");

const prisma = new PrismaClient();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function slug(value, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${name} must be a lowercase URL slug.`);
  }
  return value;
}

async function main() {
  const existing = await prisma.tenant.count();
  if (existing !== 0) {
    throw new Error("Bootstrap refused: this database already contains a tenant.");
  }

  const password = required("BOOTSTRAP_OWNER_PASSWORD");
  if (password.length < 14 || /password123|lodgiva|changeme/i.test(password)) {
    throw new Error("BOOTSTRAP_OWNER_PASSWORD must be 14+ characters and not a documented/default value.");
  }

  const input = {
    legalName: required("BOOTSTRAP_TENANT_LEGAL_NAME"),
    displayName: required("BOOTSTRAP_TENANT_DISPLAY_NAME"),
    tenantSlug: slug(required("BOOTSTRAP_TENANT_SLUG"), "BOOTSTRAP_TENANT_SLUG"),
    propertyName: required("BOOTSTRAP_PROPERTY_NAME"),
    propertyCode: required("BOOTSTRAP_PROPERTY_CODE").toUpperCase(),
    propertySlug: slug(required("BOOTSTRAP_PROPERTY_SLUG"), "BOOTSTRAP_PROPERTY_SLUG"),
    ownerEmail: required("BOOTSTRAP_OWNER_EMAIL").toLowerCase(),
    ownerName: required("BOOTSTRAP_OWNER_NAME"),
    timezone: process.env.BOOTSTRAP_PROPERTY_TIMEZONE?.trim() || "Africa/Lagos",
    currency: process.env.BOOTSTRAP_CURRENCY?.trim().toUpperCase() || "NGN",
  };
  if (!/^\S+@\S+\.\S+$/.test(input.ownerEmail)) throw new Error("BOOTSTRAP_OWNER_EMAIL is invalid.");

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: {
      legalName: input.legalName,
      displayName: input.displayName,
      slug: input.tenantSlug,
      defaultCurrency: input.currency,
      mfaRequiredRoles: JSON.stringify(["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE"]),
    } });
    const property = await tx.property.create({ data: {
      tenantId: tenant.id,
      name: input.propertyName,
      code: input.propertyCode,
      slug: input.propertySlug,
      timezone: input.timezone,
      businessDate: new Date().toISOString().slice(0, 10),
    } });
    const owner = await tx.user.create({ data: {
      email: input.ownerEmail,
      fullName: input.ownerName,
      passwordHash,
    } });
    await tx.membership.create({ data: {
      tenantId: tenant.id,
      userId: owner.id,
      role: "TENANT_OWNER",
      allProperties: true,
    } });
    return { tenantId: tenant.id, propertyId: property.id, ownerEmail: owner.email };
  });

  console.log("Production workspace created.");
  console.log(`Tenant: ${result.tenantId}`);
  console.log(`Property: ${result.propertyId}`);
  console.log(`Owner: ${result.ownerEmail}`);
  console.log("The owner must enrol MFA on first sign-in.");
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
