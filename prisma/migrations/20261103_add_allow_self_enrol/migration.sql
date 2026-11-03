-- AlterTable: Add allowSelfEnrol column to Setting table
ALTER TABLE "Setting" ADD COLUMN IF NOT EXISTS "allowSelfEnrol" BOOLEAN NOT NULL DEFAULT false;
