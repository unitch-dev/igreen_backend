import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileAsset, FileEntityType } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';

export interface UploadFileParams {
  buffer: Buffer;
  organizationId: string;
  entityType: FileEntityType;
  entityId?: string;
  category?: string;
  fileName: string;
  mimeType: string;
  uploadedById?: string;
}

@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);
  private readonly localDir: string;
  private readonly appUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.appUrl = this.config.get<string>('appUrl');
    this.localDir = path.join(process.cwd(), this.config.get<string>('storage.localDir'));
  }

  /**
   * Ensures the local upload directory exists. Resilient by design — if the
   * directory cannot be created at boot, this logs a warning and does NOT
   * crash app startup (uploads will fail loudly at request time instead).
   */
  async onModuleInit(): Promise<void> {
    try {
      await fs.mkdir(this.localDir, { recursive: true });
      this.logger.log(`Local file storage ready at ${this.localDir}`);
    } catch (err) {
      this.logger.warn(`Could not create local upload directory ${this.localDir}: ${err.message}`);
    }
  }

  /**
   * Writes the file to disk, then creates the FileAsset row — the single
   * source of truth for lookup/delete. Folder convention (built once, here,
   * so no caller ever hand-builds a path again):
   *   uploads/{entityType}/{organizationId}/{entityId ?? 'unassigned'}/{uuid}-{fileName}
   *
   * If the DB write fails after the disk write succeeded, the just-written
   * file is unlinked before rethrowing so no untracked orphan file remains.
   */
  async upload(params: UploadFileParams): Promise<FileAsset> {
    const {
      buffer,
      organizationId,
      entityType,
      entityId,
      category,
      fileName,
      mimeType,
      uploadedById,
    } = params;

    const relativePath = path.join(
      entityType,
      organizationId,
      entityId ?? 'unassigned',
      `${uuidv4()}-${fileName}`,
    );
    const destination = path.join(this.localDir, relativePath);

    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, buffer);
    } catch (err) {
      this.logger.error(`Failed to write local file ${relativePath}: ${err.message}`, err.stack);
      throw new ServiceUnavailableException(
        'File storage is currently unavailable. Please try again later or contact support.',
      );
    }

    try {
      return await this.prisma.fileAsset.create({
        data: {
          organizationId,
          entityType,
          entityId,
          category,
          fileName,
          filePath: relativePath,
          url: `${this.appUrl}/uploads/${relativePath}`,
          mimeType,
          sizeBytes: buffer.length,
          uploadedById,
        },
      });
    } catch (err) {
      // DB write failed after a successful disk write — unlink the orphan
      // file so it doesn't linger untracked, then rethrow.
      await fs.unlink(destination).catch(() => {});
      this.logger.error(
        `Failed to create FileAsset row for ${relativePath}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  /**
   * Looks up the FileAsset, best-effort unlinks the disk file, then
   * HARD-deletes the row. No-op (no throw) if the row doesn't exist.
   *
   * Hard delete (not soft-delete like the rest of the codebase) is
   * intentional: a FileAsset row pointing at an unlinked file is a dangling
   * pointer with no audit value, so there's nothing worth retaining.
   */
  async deleteFile(fileAssetId: string): Promise<void> {
    const asset = await this.prisma.fileAsset.findUnique({ where: { id: fileAssetId } });
    if (!asset) return;

    try {
      await fs.unlink(path.join(this.localDir, asset.filePath));
    } catch (err) {
      this.logger.error(`Failed to delete local file ${asset.filePath}: ${err.message}`);
    }

    await this.prisma.fileAsset.delete({ where: { id: fileAssetId } });
  }
}
