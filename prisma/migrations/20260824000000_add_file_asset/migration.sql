-- CreateTable
CREATE TABLE `file_assets` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `entityType` ENUM('EMPLOYEE_DOCUMENT', 'EMPLOYEE_PROFILE_PHOTO', 'ORGANIZATION_LOGO', 'CHAT_ATTACHMENT', 'NOTICE_ATTACHMENT', 'ONBOARDING_DOCUMENT') NOT NULL,
    `entityId` VARCHAR(191) NULL,
    `category` VARCHAR(191) NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `filePath` VARCHAR(191) NOT NULL,
    `url` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `uploadedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `file_assets_organizationId_idx`(`organizationId`),
    INDEX `file_assets_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

