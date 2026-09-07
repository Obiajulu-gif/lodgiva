// Explicit disposable fixture for manual browser QA. No production seed reset.
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const slug = 'dashboard-qa-20260907';
const email = 'dashboard-qa-20260907@lodgiva.test';
try {
  if (process.argv.includes('--cleanup')) {
    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    const user = await prisma.user.findUnique({ where: { email } });
    if (tenant) {
      for (const model of ['cashMovement','posOrderLine','posOrder','cashierShift','folioEntry','payment','roomNightAllocation','reservationRoom','housekeepingTask','folio','reservation','guest','menuItem','outlet','roomBlock','room','roomType','amenity','auditEvent','outboxEvent','membershipProperty','membership','property']) {
        await prisma[model].deleteMany({ where: { tenantId: tenant.id } });
      }
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
    if (user) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
    console.log('Disposable dashboard fixture removed.');
  } else {
    if (await prisma.tenant.findUnique({ where: { slug } })) throw Error('Fixture already exists; clean it before reusing.');
    const hash = await argon2.hash('Dashboard-QA-Only-2026!');
    await prisma.$transaction(async tx => {
      const tenant = await tx.tenant.create({ data: { slug, legalName: 'Disposable Dashboard QA', displayName: 'Disposable Dashboard QA' } });
      const user = await tx.user.create({ data: { email, fullName: 'Dashboard QA', passwordHash: hash } });
      await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'GENERAL_MANAGER', allProperties: true } });
      for (const code of ['QA1','QA2']) {
        await tx.property.create({ data: { tenantId: tenant.id, code, slug: code.toLowerCase(), name: `Test Hotel ${code}`, businessDate: '2026-09-07' } });
      }
    }, { timeout: 60000 });
    console.log('Disposable two-property fixture ready: '+email);
  }
} finally { await prisma.$disconnect(); }
