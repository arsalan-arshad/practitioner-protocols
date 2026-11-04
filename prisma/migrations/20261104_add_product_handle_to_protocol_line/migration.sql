-- AlterTable: Add productHandle column to ProtocolLine table
ALTER TABLE "ProtocolLine" ADD COLUMN IF NOT EXISTS "productHandle" TEXT;
