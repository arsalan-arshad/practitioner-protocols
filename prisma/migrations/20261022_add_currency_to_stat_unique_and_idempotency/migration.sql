-- AlterIndex: Drop old unique index on ProtocolOrderStat
DROP INDEX IF EXISTS "ProtocolOrderStat_shop_protocolId_month_key";

-- CreateIndex: Create new unique index on ProtocolOrderStat including currency
CREATE UNIQUE INDEX "ProtocolOrderStat_shop_protocolId_month_currency_key" ON "ProtocolOrderStat"("shop", "protocolId", "month", "currency");

-- CreateTable: ProcessedWebhook for idempotency (least-privacy-invasive, zero PII)
CREATE TABLE IF NOT EXISTS "ProcessedWebhook" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Unique index on ProcessedWebhook (shop, webhookId)
CREATE UNIQUE INDEX IF NOT EXISTS "ProcessedWebhook_shop_webhookId_key" ON "ProcessedWebhook"("shop", "webhookId");

-- CreateIndex: Index on ProcessedWebhook processedAt for retention pruning
CREATE INDEX IF NOT EXISTS "ProcessedWebhook_processedAt_idx" ON "ProcessedWebhook"("processedAt");
