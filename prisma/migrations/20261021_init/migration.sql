-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Protocol" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "introNote" TEXT,
    "displayName" TEXT,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "isStarter" BOOLEAN NOT NULL DEFAULT false,
    "sourceProtocolId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Protocol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolLine" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "variantGid" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "usageNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtocolLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PractitionerProfile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL DEFAULT 'customer',
    "ownerGid" TEXT NOT NULL,
    "practiceName" TEXT NOT NULL,
    "logoUrl" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PractitionerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolOrderStat" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "revenueMinor" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtocolOrderStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "shop" TEXT NOT NULL,
    "identityMode" TEXT NOT NULL DEFAULT 'tag',
    "footerDisclaimer" TEXT,
    "handoutText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Protocol_token_key" ON "Protocol"("token");

-- CreateIndex
CREATE INDEX "Protocol_shop_ownerType_ownerId_idx" ON "Protocol"("shop", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "Protocol_shop_token_idx" ON "Protocol"("shop", "token");

-- CreateIndex
CREATE INDEX "Protocol_shop_isStarter_idx" ON "Protocol"("shop", "isStarter");

-- CreateIndex
CREATE INDEX "Protocol_shop_status_idx" ON "Protocol"("shop", "status");

-- CreateIndex
CREATE INDEX "ProtocolLine_protocolId_idx" ON "ProtocolLine"("protocolId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolLine_protocolId_variantGid_key" ON "ProtocolLine"("protocolId", "variantGid");

-- CreateIndex
CREATE INDEX "PractitionerProfile_shop_idx" ON "PractitionerProfile"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "PractitionerProfile_shop_ownerGid_key" ON "PractitionerProfile"("shop", "ownerGid");

-- CreateIndex
CREATE INDEX "ProtocolOrderStat_shop_month_idx" ON "ProtocolOrderStat"("shop", "month");

-- CreateIndex
CREATE INDEX "ProtocolOrderStat_shop_ownerId_month_idx" ON "ProtocolOrderStat"("shop", "ownerId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolOrderStat_shop_protocolId_month_key" ON "ProtocolOrderStat"("shop", "protocolId", "month");

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- AddForeignKey
ALTER TABLE "ProtocolLine" ADD CONSTRAINT "ProtocolLine_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "Protocol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtocolOrderStat" ADD CONSTRAINT "ProtocolOrderStat_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "Protocol"("id") ON DELETE CASCADE ON UPDATE CASCADE;
