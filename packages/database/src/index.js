const { PrismaClient } = require("@prisma/client");

let prisma;

/** Singleton PrismaClient shared by api/worker/seed. */
function getPrisma() {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

module.exports = { getPrisma, PrismaClient };
