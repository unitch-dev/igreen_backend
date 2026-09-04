import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FileEntityType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async findOne(organizationId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async update(organizationId: string, dto: UpdateOrganizationDto) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');

    if (dto.email && dto.email !== org.email) {
      const collision = await this.prisma.organization.findFirst({
        where: { email: dto.email, id: { not: organizationId } },
      });
      if (collision) throw new BadRequestException('Email is already used by another organization');
    }

    // Cross-field rule: enabling auto-logout without a cutoff time makes the
    // feature unreachable/undefined for the scheduler — reject early.
    const willBeEnabled = dto.autoLogoutEnabled ?? org.autoLogoutEnabled;
    const willHaveTime = dto.autoLogoutTime !== undefined ? dto.autoLogoutTime : org.autoLogoutTime;
    if (willBeEnabled && !willHaveTime) {
      throw new BadRequestException('autoLogoutTime is required when autoLogoutEnabled is true');
    }

    return this.prisma.organization.update({ where: { id: organizationId }, data: dto });
  }

  async uploadLogo(organizationId: string, file: Express.Multer.File, uploadedById?: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, logoUrl: true },
    });
    if (!org) throw new NotFoundException('Organization not found');

    const asset = await this.files.upload({
      buffer: file.buffer,
      organizationId,
      entityType: FileEntityType.ORGANIZATION_LOGO,
      entityId: organizationId,
      fileName: file.originalname,
      mimeType: file.mimetype,
      uploadedById,
    });

    // `updatedById` is NOT set here — PrismaService middleware auto-injects it
    // from the CLS-scoped JWT user on every write. Manually passing it here is
    // a documented anti-pattern (see hrms-backend.md rule #2).
    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { logoUrl: asset.url },
    });

    // Best-effort: delete every prior ORGANIZATION_LOGO FileAsset for this org.
    const priorAssets = await this.prisma.fileAsset.findMany({
      where: {
        organizationId,
        entityType: FileEntityType.ORGANIZATION_LOGO,
        entityId: organizationId,
        id: { not: asset.id },
      },
      select: { id: true },
    });
    for (const prior of priorAssets) {
      this.files.deleteFile(prior.id).catch(() => {});
    }

    return updated;
  }
}
