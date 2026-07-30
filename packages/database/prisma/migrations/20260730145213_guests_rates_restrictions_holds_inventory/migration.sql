-- CreateTable
CREATE TABLE "GuestMergeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "survivingId" TEXT NOT NULL,
    "mergedId" TEXT NOT NULL,
    "movedCounts" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RateRestriction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "ratePlanId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closedToArrival" BOOLEAN NOT NULL DEFAULT false,
    "closedToDeparture" BOOLEAN NOT NULL DEFAULT false,
    "minStay" INTEGER,
    "maxStay" INTEGER,
    "minAdvanceDays" INTEGER,
    CONSTRAINT "RateRestriction_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "RatePlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Hold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "ratePlanId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "arrivalDate" TEXT NOT NULL,
    "departureDate" TEXT NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "quotedTotalMinor" BIGINT NOT NULL,
    "quotedBreakdown" TEXT NOT NULL DEFAULT '[]',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Hold_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Hold_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoomNightAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "holdId" TEXT,
    "reservationRoomId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoomNightAllocation_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RoomNightAllocation_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "Hold" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoomNightAllocation_reservationRoomId_fkey" FOREIGN KEY ("reservationRoomId") REFERENCES "ReservationRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Guest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "nationality" TEXT,
    "notes" TEXT,
    "vip" BOOLEAN NOT NULL DEFAULT false,
    "idDocumentType" TEXT,
    "idDocumentLast4" TEXT,
    "idDocumentExpiry" TEXT,
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentUpdatedAt" DATETIME,
    "blacklisted" BOOLEAN NOT NULL DEFAULT false,
    "blacklistReason" TEXT,
    "mergedIntoId" TEXT,
    "mergedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Guest_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Guest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Guest" ("createdAt", "email", "firstName", "id", "lastName", "nationality", "notes", "phone", "tenantId", "updatedAt", "vip") SELECT "createdAt", "email", "firstName", "id", "lastName", "nationality", "notes", "phone", "tenantId", "updatedAt", "vip" FROM "Guest";
DROP TABLE "Guest";
ALTER TABLE "new_Guest" RENAME TO "Guest";
CREATE INDEX "Guest_tenantId_lastName_idx" ON "Guest"("tenantId", "lastName");
CREATE INDEX "Guest_tenantId_phone_idx" ON "Guest"("tenantId", "phone");
CREATE INDEX "Guest_tenantId_email_idx" ON "Guest"("tenantId", "email");
CREATE INDEX "Guest_tenantId_mergedIntoId_idx" ON "Guest"("tenantId", "mergedIntoId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "GuestMergeLog_tenantId_createdAt_idx" ON "GuestMergeLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "RateRestriction_tenantId_date_idx" ON "RateRestriction"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RateRestriction_ratePlanId_date_key" ON "RateRestriction"("ratePlanId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Hold_tokenHash_key" ON "Hold"("tokenHash");

-- CreateIndex
CREATE INDEX "Hold_tenantId_status_expiresAt_idx" ON "Hold"("tenantId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "RoomNightAllocation_tenantId_roomTypeId_date_idx" ON "RoomNightAllocation"("tenantId", "roomTypeId", "date");

-- CreateIndex
CREATE INDEX "RoomNightAllocation_reservationRoomId_idx" ON "RoomNightAllocation"("reservationRoomId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomNightAllocation_roomTypeId_date_slotIndex_key" ON "RoomNightAllocation"("roomTypeId", "date", "slotIndex");
