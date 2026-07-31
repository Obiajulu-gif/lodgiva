-- CreateTable
CREATE TABLE "FileObject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "declaredSize" INTEGER NOT NULL,
    "actualSize" INTEGER,
    "checksumSha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "quarantineReason" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'GENERAL',
    "uploadedById" TEXT,
    "expiresAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "FileObject_tenantId_status_idx" ON "FileObject"("tenantId", "status");

-- CreateIndex
CREATE INDEX "FileObject_tenantId_entityType_entityId_idx" ON "FileObject"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "FileObject_status_expiresAt_idx" ON "FileObject"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_bucket_objectKey_key" ON "FileObject"("bucket", "objectKey");
