import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../../common/dto/pagination.dto';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';
import { QueryZoneDto } from './dto/query-zone.dto';

@Injectable()
export class ZonesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, dto: CreateZoneDto) {
    const duplicate = await this.prisma.zone.findFirst({
      where: { organizationId, name: dto.name, deletedAt: null },
    });
    if (duplicate) {
      throw new ConflictException(`Zone "${dto.name}" already exists in this organization`);
    }

    return this.prisma.zone.create({
      data: {
        organizationId,
        name: dto.name,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async findAll(organizationId: string, query: QueryZoneDto) {
    const pagination: PaginationDto = query;
    const where = {
      organizationId,
      deletedAt: null,
      ...(query.isActive !== undefined && { isActive: query.isActive }),
    };

    const [data, total] = await Promise.all([
      this.prisma.zone.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.zone.count({ where }),
    ]);

    return paginate(data, total, pagination);
  }

  async findOne(organizationId: string, id: string) {
    const zone = await this.prisma.zone.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!zone) throw new NotFoundException('Zone not found');
    return zone;
  }

  async update(organizationId: string, id: string, dto: UpdateZoneDto) {
    const zone = await this.prisma.zone.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!zone) throw new NotFoundException('Zone not found');

    if (dto.name && dto.name !== zone.name) {
      const duplicate = await this.prisma.zone.findFirst({
        where: { organizationId, name: dto.name, id: { not: id }, deletedAt: null },
      });
      if (duplicate) {
        throw new ConflictException(`Zone "${dto.name}" already exists in this organization`);
      }
    }

    return this.prisma.zone.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async remove(organizationId: string, id: string) {
    const zone = await this.prisma.zone.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!zone) throw new NotFoundException('Zone not found');

    const employeeCount = await this.prisma.employee.count({
      where: { zoneId: id, deletedAt: null },
    });
    if (employeeCount > 0) {
      throw new BadRequestException(
        `Cannot delete zone — ${employeeCount} employee(s) are assigned to it`,
      );
    }

    await this.prisma.zone.update({ where: { id }, data: { deletedAt: new Date() } });
    return { deleted: true, message: `Zone "${zone.name}" deleted successfully` };
  }
}
