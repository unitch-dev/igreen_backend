import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { paginate } from '@common/dto/pagination.dto';
import { WorkLocationsService } from '../../organizations/work-locations/work-locations.service';
import { CreateOdDto } from './dto/create-od.dto';
import { AddOdLocationDto } from './dto/add-od-location.dto';
import { QueryOdDto } from './dto/query-od.dto';

export const ATTENDANCE_READ_PERMISSION = 'attendance:read';
export const ATTENDANCE_CHECKIN_PERMISSION = 'attendance:checkin';

export interface RequestingUser {
  employeeId: string | null;
  permissions: string[];
}

// Builds a UTC-midnight Date for the LOCAL calendar day of `date` — see the
// identical helper + comment in `attendance.service.ts` (hrms-backend.md rule
// #19). Using local-midnight `setHours(0,0,0,0)` here broke same-day OD
// accumulation with a `unique constraint failed` 500 on the second
// `POST /attendance/od` call of the day, and `?date=` filtering, in any
// positive-UTC-offset timezone.
function startOfDay(date: Date | string): Date {
  const d = new Date(date);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

const OD_RECORD_WITH_ENTRIES = {
  entries: { orderBy: { recordedAt: 'asc' } },
} satisfies Prisma.OdRecordInclude;

@Injectable()
export class OdService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workLocationsService: WorkLocationsService,
  ) {}

  private hasReadPermission(currentUser: RequestingUser): boolean {
    return (
      currentUser.permissions.includes(ATTENDANCE_READ_PERMISSION) ||
      currentUser.permissions.includes('*')
    );
  }

  private async assertEmployeeInOrg(organizationId: string, employeeId: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found in this organization');
    return employee;
  }

  private async upsertAttendanceOnDuty(employeeId: string, date: Date) {
    await this.prisma.attendanceLog.upsert({
      where: { employeeId_date: { employeeId, date } },
      create: {
        employeeId,
        date,
        status: AttendanceStatus.ON_DUTY,
        source: 'MOBILE',
      },
      update: {
        status: AttendanceStatus.ON_DUTY,
      },
    });
  }

  private async recomputeTotalMinutes(odRecordId: string) {
    const aggregate = await this.prisma.odLocationEntry.aggregate({
      where: { odRecordId },
      _sum: { minutes: true },
    });
    return this.prisma.odRecord.update({
      where: { id: odRecordId },
      data: { totalMinutes: aggregate._sum.minutes ?? 0 },
      include: OD_RECORD_WITH_ENTRIES,
    });
  }

  async create(organizationId: string, currentUser: RequestingUser, dto: CreateOdDto) {
    const employeeId = currentUser.employeeId;
    if (!employeeId) {
      throw new BadRequestException('No employee record found for the current user');
    }
    await this.assertEmployeeInOrg(organizationId, employeeId);

    const date = startOfDay(new Date());

    // GPS may be unavailable (denied permission, indoor signal loss, desktop
    // entry) — default to 0,0 rather than rejecting the OD entry outright.
    const lat = dto.lat ?? 0;
    const lng = dto.lng ?? 0;
    const locationName = await this.workLocationsService.resolveLocationName(
      organizationId,
      lat,
      lng,
    );

    const existing = await this.prisma.odRecord.findUnique({
      where: { employeeId_date: { employeeId, date } },
    });

    const odRecordId = existing
      ? existing.id
      : (
          await this.prisma.odRecord.create({
            data: { organizationId, employeeId, date, reason: dto.reason },
          })
        ).id;

    if (existing && dto.reason && !existing.reason) {
      await this.prisma.odRecord.update({
        where: { id: odRecordId },
        data: { reason: dto.reason },
      });
    }

    await this.prisma.odLocationEntry.create({
      data: {
        odRecordId,
        lat,
        lng,
        locationName,
        minutes: dto.minutes,
      },
    });

    const updated = await this.recomputeTotalMinutes(odRecordId);
    await this.upsertAttendanceOnDuty(employeeId, date);

    return updated;
  }

  async addLocation(
    organizationId: string,
    currentUser: RequestingUser,
    id: string,
    dto: AddOdLocationDto,
  ) {
    if (!id) throw new BadRequestException('OD record id is required');

    const record = await this.prisma.odRecord.findFirst({
      where: { id, organizationId },
    });
    if (!record) throw new NotFoundException('OD record not found');

    if (!this.hasReadPermission(currentUser)) {
      if (!currentUser.employeeId || record.employeeId !== currentUser.employeeId) {
        throw new ForbiddenException("You cannot add a location to another employee's OD record");
      }
    }

    // GPS may be unavailable (denied permission, indoor signal loss, desktop
    // entry) — default to 0,0 rather than rejecting the OD entry outright.
    const lat = dto.lat ?? 0;
    const lng = dto.lng ?? 0;
    const locationName = await this.workLocationsService.resolveLocationName(
      organizationId,
      lat,
      lng,
    );

    await this.prisma.odLocationEntry.create({
      data: {
        odRecordId: record.id,
        lat,
        lng,
        locationName,
        minutes: dto.minutes,
      },
    });

    const updated = await this.recomputeTotalMinutes(record.id);
    await this.upsertAttendanceOnDuty(record.employeeId, record.date);

    return updated;
  }

  async findAll(organizationId: string, currentUser: RequestingUser, query: QueryOdDto) {
    const canSeeAll = this.hasReadPermission(currentUser);
    const canSeeSelf =
      currentUser.permissions.includes(ATTENDANCE_CHECKIN_PERMISSION) ||
      currentUser.permissions.includes('*');
    if (!canSeeAll && !canSeeSelf) {
      throw new ForbiddenException(
        `Missing required permissions: ${ATTENDANCE_READ_PERMISSION} or ${ATTENDANCE_CHECKIN_PERMISSION}`,
      );
    }

    const scopedEmployeeId = canSeeAll ? query.employeeId : currentUser.employeeId;

    if (!canSeeAll && !scopedEmployeeId) {
      return paginate([], 0, query);
    }

    const where: Prisma.OdRecordWhereInput = {
      organizationId,
      ...(scopedEmployeeId && { employeeId: scopedEmployeeId }),
      ...(query.date && { date: startOfDay(query.date) }),
    };

    const [data, total] = await Promise.all([
      this.prisma.odRecord.findMany({
        where,
        include: OD_RECORD_WITH_ENTRIES,
        orderBy: { date: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.odRecord.count({ where }),
    ]);

    return paginate(data, total, query);
  }
}
