-- AlterTable
ALTER TABLE `organizations`
  ADD COLUMN `autoLogoutEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `autoLogoutTime` VARCHAR(191) NULL,
  ADD COLUMN `autoLogoutTimezone` VARCHAR(191) NOT NULL DEFAULT 'Asia/Kolkata';
