import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '@common/dto/pagination.dto';
import { GlobalLeaveItemDto } from './dto/global-leave-item.dto';
import { BulkCreateGlobalLeaveDto } from './dto/bulk-create-global-leave.dto';
import { QueryGlobalLeaveDto } from './dto/query-global-leave.dto';

export interface BulkCreateRowError {
  index: number;
  name: string;
  error: string;
}

@Injectable()
export class GlobalLeaveService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, createdById: string | null, dto: GlobalLeaveItemDto) {
    await this.assertZonesBelongToOrg(organizationId, dto.zoneIds);

    return this.prisma.globalLeave.create({
      data: {
        organizationId,
        name: dto.name,
        date: new Date(dto.date),
        appliesToAll: dto.appliesToAll ?? false,
        createdById: createdById ?? undefined,
        ...(!dto.appliesToAll && dto.zoneIds?.length
          ? { zones: { connect: dto.zoneIds.map((id) => ({ id })) } }
          : {}),
      },
      include: { zones: { select: { id: true, name: true } } },
    });
  }

  /**
   * Validates every row up front (via class-validator on the DTO before this
   * is even called) and then, for each row, verifies its zoneIds resolve
   * within this organization. A bad row is recorded as an error rather than
   * aborting the whole batch — mirrors the codebase's "don't let one bad row
   * 500 the whole batch" convention for bulk endpoints.
   */
  async bulkCreate(
    organizationId: string,
    createdById: string | null,
    dto: BulkCreateGlobalLeaveDto,
  ) {
    const zoneIds = await this.prisma.zone.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true },
    });
    const validZoneIds = new Set(zoneIds.map((z) => z.id));

    const toCreate: Array<{
      organizationId: string;
      name: string;
      date: Date;
      appliesToAll: boolean;
      createdById: string | null;
      zoneIds: string[];
    }> = [];
    const errors: BulkCreateRowError[] = [];

    dto.items.forEach((item, index) => {
      const invalidZoneIds = (item.zoneIds ?? []).filter((id) => !validZoneIds.has(id));
      if (!item.appliesToAll && invalidZoneIds.length > 0) {
        errors.push({
          index,
          name: item.name,
          error: `Unknown zone id(s) in this organization: ${invalidZoneIds.join(', ')}`,
        });
        return;
      }

      toCreate.push({
        organizationId,
        name: item.name,
        date: new Date(item.date),
        appliesToAll: item.appliesToAll ?? false,
        createdById,
        zoneIds: item.appliesToAll ? [] : (item.zoneIds ?? []),
      });
    });

    const created = await this.prisma.$transaction(
      toCreate.map((row) =>
        this.prisma.globalLeave.create({
          data: {
            organizationId: row.organizationId,
            name: row.name,
            date: row.date,
            appliesToAll: row.appliesToAll,
            createdById: row.createdById ?? undefined,
            ...(row.zoneIds.length
              ? { zones: { connect: row.zoneIds.map((id) => ({ id })) } }
              : {}),
          },
        }),
      ),
    );

    return {
      createdCount: created.length,
      errorCount: errors.length,
      errors,
    };
  }

  async findAll(organizationId: string, query: QueryGlobalLeaveDto) {
    const where = {
      organizationId,
      ...(query.year !== undefined && {
        date: {
          gte: new Date(Date.UTC(query.year, 0, 1)),
          lt: new Date(Date.UTC(query.year + 1, 0, 1)),
        },
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.globalLeave.findMany({
        where,
        include: { zones: { select: { id: true, name: true } } },
        orderBy: { date: 'asc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.globalLeave.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async delete(organizationId: string, id: string) {
    const globalLeave = await this.prisma.globalLeave.findFirst({
      where: { id, organizationId },
    });
    if (!globalLeave) throw new NotFoundException('Global leave not found');

    await this.prisma.globalLeave.delete({ where: { id } });
    return { deleted: true, message: `Global leave "${globalLeave.name}" deleted successfully` };
  }

  /**
   * Global leaves visible to an employee's calendar: unconditional
   * (appliesToAll) entries, plus zone-tagged entries where the employee's
   * Zone matches one of the tagged zones. Skips the zone OR-branch entirely
   * when the employee has no zoneId.
   *
   * `employeeId` may be `null` for org-level admin accounts (`org_admin`/
   * `super_admin`) that have no linked Employee row — this is a read-only,
   * informational, org-wide holiday calendar endpoint, so a null employeeId
   * is treated as "no zone" rather than an error: the employee/zone lookup
   * is skipped entirely and only appliesToAll (org-wide) entries are
   * returned. See docs/known-issues.md (2026-08-28) for the bug class.
   */
  async getForEmployee(organizationId: string, employeeId: string | null, year: number) {
    const dateRange = {
      gte: new Date(Date.UTC(year, 0, 1)),
      lt: new Date(Date.UTC(year + 1, 0, 1)),
    };

    let zoneId: string | null = null;
    if (employeeId) {
      const employee = await this.prisma.employee.findFirst({
        where: { id: employeeId, organizationId, deletedAt: null },
        select: { zoneId: true },
      });
      if (!employee) throw new NotFoundException('Employee not found');
      zoneId = employee.zoneId;
    }

    return this.prisma.globalLeave.findMany({
      where: {
        organizationId,
        date: dateRange,
        OR: [
          { appliesToAll: true },
          ...(zoneId ? [{ zones: { some: { id: zoneId } } }] : []),
        ],
      },
      orderBy: { date: 'asc' },
    });
  }

  private async assertZonesBelongToOrg(organizationId: string, zoneIds?: string[]) {
    if (!zoneIds || zoneIds.length === 0) return;
    const count = await this.prisma.zone.count({
      where: { id: { in: zoneIds }, organizationId, deletedAt: null },
    });
    if (count !== zoneIds.length) {
      throw new BadRequestException('One or more zone ids were not found in this organization');
    }
  }
}
