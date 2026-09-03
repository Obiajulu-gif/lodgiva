-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NightAuditRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "phase" TEXT NOT NULL DEFAULT 'COMPLETED',
    "steps" TEXT NOT NULL DEFAULT '[]',
    "blockers" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL,
    "runById" TEXT,
    "completedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NightAuditRun_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_NightAuditRun" ("businessDate", "completedAt", "id", "propertyId", "status", "summary", "tenantId") SELECT "businessDate", "completedAt", "id", "propertyId", "status", "summary", "tenantId" FROM "NightAuditRun";
DROP TABLE "NightAuditRun";
ALTER TABLE "new_NightAuditRun" RENAME TO "NightAuditRun";
CREATE UNIQUE INDEX "NightAuditRun_propertyId_businessDate_key" ON "NightAuditRun"("propertyId", "businessDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
