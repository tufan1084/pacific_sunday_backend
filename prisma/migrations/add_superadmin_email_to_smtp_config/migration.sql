-- Add superadmin email field to SMTP configuration
ALTER TABLE "smtp_config" ADD COLUMN IF NOT EXISTS "superadminEmail" TEXT;
