-- CreateTable: ShopperContact (M11 Shopper Opt-In)
CREATE TABLE IF NOT EXISTS "ShopperContact" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "consentText" TEXT NOT NULL,
    "consentVersion" INTEGER NOT NULL DEFAULT 1,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'protocol_page',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopperContact_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one contact per shop, practitioner/practice owner, and email
CREATE UNIQUE INDEX IF NOT EXISTS "ShopperContact_shop_ownerId_email_key" ON "ShopperContact"("shop", "ownerId", "email");
CREATE INDEX IF NOT EXISTS "ShopperContact_shop_email_idx" ON "ShopperContact"("shop", "email");
CREATE INDEX IF NOT EXISTS "ShopperContact_shop_ownerId_idx" ON "ShopperContact"("shop", "ownerId");

-- CreateTable: MerchantFeedback (M11 Settings custom request & developer feedback)
CREATE TABLE IF NOT EXISTS "MerchantFeedback" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopName" TEXT,
    "ownerName" TEXT,
    "replyEmail" TEXT,
    "planName" TEXT,
    "country" TEXT,
    "message" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'feedback',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MerchantFeedback_shop_idx" ON "MerchantFeedback"("shop");
CREATE INDEX IF NOT EXISTS "MerchantFeedback_kind_idx" ON "MerchantFeedback"("kind");
