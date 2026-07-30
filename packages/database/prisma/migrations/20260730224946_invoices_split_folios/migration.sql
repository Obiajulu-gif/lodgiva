-- AlterTable
ALTER TABLE "FolioEntry" ADD COLUMN "transferGroupId" TEXT;

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'INVOICE',
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "snapshot" TEXT NOT NULL,
    "subtotalMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "businessDate" TEXT NOT NULL,
    "issuedById" TEXT,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    "reversesId" TEXT,
    CONSTRAINT "Invoice_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "Folio" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvoiceSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Folio" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reservationId" TEXT,
    "guestId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Main',
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Folio_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Folio_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Folio" ("closedAt", "createdAt", "currency", "guestId", "id", "propertyId", "reservationId", "status", "tenantId") SELECT "closedAt", "createdAt", "currency", "guestId", "id", "propertyId", "reservationId", "status", "tenantId" FROM "Folio";
DROP TABLE "Folio";
ALTER TABLE "new_Folio" RENAME TO "Folio";
CREATE INDEX "Folio_tenantId_propertyId_status_idx" ON "Folio"("tenantId", "propertyId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_reversesId_key" ON "Invoice"("reversesId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_propertyId_businessDate_idx" ON "Invoice"("tenantId", "propertyId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_propertyId_invoiceNumber_key" ON "Invoice"("tenantId", "propertyId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSequence_propertyId_series_key" ON "InvoiceSequence"("propertyId", "series");
