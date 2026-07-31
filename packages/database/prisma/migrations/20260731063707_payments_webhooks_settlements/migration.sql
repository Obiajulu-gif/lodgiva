-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "providerRef" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "checkoutUrl" TEXT,
    "failureReason" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" DATETIME,
    CONSTRAINT "PaymentIntent_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "Folio" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT,
    "rawBody" TEXT NOT NULL,
    "signature" TEXT,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "rejectReason" TEXT,
    "tenantId" TEXT,
    "intentId" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "method" TEXT NOT NULL,
    "providerRef" TEXT,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "decisionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" DATETIME,
    CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "settledOn" TEXT NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "netMinor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IMPORTED',
    "importedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SettlementLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "netMinor" BIGINT NOT NULL,
    "paidOn" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    CONSTRAINT "SettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReconciliationException" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "settlementId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "providerRef" TEXT,
    "paymentId" TEXT,
    "expectedMinor" BIGINT,
    "actualMinor" BIGINT,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "ReconciliationException_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "provider" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "externalReference" TEXT,
    "idempotencyKey" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "intentId" TEXT,
    "settlementLineId" TEXT,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "refundedMinor" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "Payment_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "Folio" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Payment_settlementLineId_fkey" FOREIGN KEY ("settlementLineId") REFERENCES "SettlementLine" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Payment" ("amountMinor", "externalReference", "folioId", "id", "idempotencyKey", "method", "propertyId", "provider", "receivedAt", "recordedById", "status", "tenantId") SELECT "amountMinor", "externalReference", "folioId", "id", "idempotencyKey", "method", "propertyId", "provider", "receivedAt", "recordedById", "status", "tenantId" FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
CREATE UNIQUE INDEX "Payment_settlementLineId_key" ON "Payment"("settlementLineId");
CREATE INDEX "Payment_tenantId_propertyId_status_idx" ON "Payment"("tenantId", "propertyId", "status");
CREATE INDEX "Payment_tenantId_externalReference_idx" ON "Payment"("tenantId", "externalReference");
CREATE UNIQUE INDEX "Payment_tenantId_idempotencyKey_key" ON "Payment"("tenantId", "idempotencyKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PaymentIntent_tenantId_status_idx" ON "PaymentIntent"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_tenantId_reference_key" ON "PaymentIntent"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_status_receivedAt_idx" ON "WebhookEvent"("provider", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_key" ON "WebhookEvent"("provider", "externalId");

-- CreateIndex
CREATE INDEX "Refund_tenantId_propertyId_status_idx" ON "Refund"("tenantId", "propertyId", "status");

-- CreateIndex
CREATE INDEX "Settlement_tenantId_propertyId_settledOn_idx" ON "Settlement"("tenantId", "propertyId", "settledOn");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_tenantId_provider_reference_key" ON "Settlement"("tenantId", "provider", "reference");

-- CreateIndex
CREATE INDEX "SettlementLine_tenantId_status_idx" ON "SettlementLine"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementLine_settlementId_providerRef_key" ON "SettlementLine"("settlementId", "providerRef");

-- CreateIndex
CREATE INDEX "ReconciliationException_tenantId_propertyId_status_idx" ON "ReconciliationException"("tenantId", "propertyId", "status");
