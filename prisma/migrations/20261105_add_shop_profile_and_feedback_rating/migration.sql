-- CreateTable: ShopProfile (M11 Merchant Profile and Opt-In)
CREATE TABLE IF NOT EXISTS "ShopProfile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopName" TEXT,
    "ownerName" TEXT,
    "email" TEXT,
    "planName" TEXT,
    "country" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "marketingOptInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopProfile_shop_key" ON "ShopProfile"("shop");
CREATE INDEX IF NOT EXISTS "ShopProfile_shop_idx" ON "ShopProfile"("shop");

-- AlterTable: MerchantFeedback add rating column (1-5)
ALTER TABLE "MerchantFeedback" ADD COLUMN IF NOT EXISTS "rating" INTEGER CHECK ("rating" >= 1 AND "rating" <= 5);
