import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '@common/dto/pagination.dto';
import { WorkLocationsService } from '../organizations/work-locations/work-locations.service';
import { CheckInDto, LiveLocationDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';
import { ManualEntryDto } from './dto/manual-entry.dto';
import { CorrectionRequestDto } from './dto/correction-request.dto';
import { ApproveCorrectionDto } from './dto/approve-correction.dto';
import { QueryAttendanceDto } from './dto/query-attendance.dto';

const STANDARD_WORKDAY_HOURS = 8;
const MS_PER_HOUR = 3600000;

// Builds a UTC-midnight Date for the LOCAL calendar day of `date`, matching how
// MySQL round-trips a `@db.Date` column (the mysql2 driver serializes/deserializes
// DATE values in UTC). Using `d.setHours(0, 0, 0, 0)` (LOCAL midnight) instead
// would produce two DIFFERENT instants for "the same day" once one has passed
// through a write+read cycle in any positive-UTC-offset timezone (e.g. IST,
// UTC+5:30): local midnight serializes to the PREVIOUS UTC calendar date, so a
// freshly computed `startOfDay(new Date())` would never match a value already
// persisted for "today", breaking `@@unique([employeeId, date])` lookups
// (open check-in/check-out log, OD accumulation) and `?date=` filters. See
// docs/known-issues.md 2026-08-14 and hrms-backend.md rule #19.
function startOfDay(date: Date | string): Date {
  const d = new Date(date);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workLocationsService: WorkLocationsService,
  ) {}

  private async assertEmployeeInOrg(organizationId: string, employeeId: string) {
    // Guard BEFORE the Prisma call: a falsy `employeeId` (e.g. an account with
    // no linked Employee row, like the seeded super_admin) passed as `id: null`
    // into a `where` filter on a non-nullable String field throws an uncaught
    // PrismaClientValidationError -> raw 500, instead of the clean 4xx every
    // sibling "no employee record" guard in the codebase returns (loans, chat,
    // notices, green-thanks, todos, performance — see known-issues.md). Fail
    // closed with a clean, documented error instead.
    if (!employeeId) {
      throw new BadRequestException('No employee record found for the current user');
    }
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found in this organization');
    return employee;
  }

  async checkIn(organizationId: string, employeeId: string, dto: CheckInDto) {
    await this.assertEmployeeInOrg(organizationId, employeeId);

    const timestamp = dto.timestamp ? new Date(dto.timestamp) : new Date();
    const date = startOfDay(timestamp);

    const openLog = await this.prisma.attendanceLog.findFirst({
      where: { employeeId, date, checkOutAt: null },
    });
    if (openLog) {
      throw new ConflictException(
        'An open attendance log already exists for today. Please check out first.',
      );
    }

    // GPS may be unavailable (denied permission, indoor signal loss, desktop
    // check-in) — default to 0,0 rather than rejecting the check-in outright.
    const lat = dto.lat ?? 0;
    const lng = dto.lng ?? 0;

    const checkInLocationName = await this.workLocationsService.resolveLocationName(
      organizationId,
      lat,
      lng,
    );

    const log = await this.prisma.attendanceLog.create({
      data: {
        employeeId,
        date,
        checkInAt: timestamp,
        checkInLat: lat,
        checkInLng: lng,
        checkInLocationName,
        source: dto.source ?? 'MOBILE',
        status: AttendanceStatus.PRESENT,
      },
    });

    await this.upsertLiveLocation(employeeId, {
      lat,
      lng,
      accuracy: dto.accuracy,
    });

    return log;
  }

  async checkOut(organizationId: string, employeeId: string, dto: CheckOutDto) {
    await this.assertEmployeeInOrg(organizationId, employeeId);

    const timestamp = dto.timestamp ? new Date(dto.timestamp) : new Date();
    const date = startOfDay(timestamp);

    const openLog = await this.prisma.attendanceLog.findFirst({
      where: { employeeId, date, checkOutAt: null },
    });
    if (!openLog) {
      throw new NotFoundException('No open check-in found for today');
    }

    const totalHours = (timestamp.getTime() - openLog.checkInAt!.getTime()) / MS_PER_HOUR;
    const overtimeHours = Math.max(0, totalHours - STANDARD_WORKDAY_HOURS);

    // GPS may be unavailable at checkout too — default to 0,0 rather than
    // rejecting or silently leaving location fields unset (see checkIn above).
    const lat = dto.lat ?? 0;
    const lng = dto.lng ?? 0;

    const checkOutLocationName = await this.workLocationsService.resolveLocationName(
      organizationId,
      lat,
      lng,
    );

    const log = await this.prisma.attendanceLog.update({
      where: { id: openLog.id },
      data: {
        checkOutAt: timestamp,
        checkOutLat: lat,
        checkOutLng: lng,
        checkOutLocationName,
        totalHours,
        overtimeHours,
      },
    });

    await this.upsertLiveLocation(employeeId, { lat, lng });

    return log;
  }

  async liveUpdate(organizationId: string, employeeId: string, dto: LiveLocationDto) {
    await this.assertEmployeeInOrg(organizationId, employeeId);
    return this.upsertLiveLocation(employeeId, dto);
  }

  private async upsertLiveLocation(employeeId: string, dto: LiveLocationDto) {
    const existing = await this.prisma.liveLocation.findFirst({
      where: { employeeId },
      orderBy: { recordedAt: 'desc' },
    });

    if (existing) {
      return this.prisma.liveLocation.update({
        where: { id: existing.id },
        data: { lat: dto.lat, lng: dto.lng, accuracy: dto.accuracy, recordedAt: new Date() },
      });
    }

    return this.prisma.liveLocation.create({
      data: { employeeId, lat: dto.lat, lng: dto.lng, accuracy: dto.accuracy },
    });
  }

  async getLiveLocations(organizationId: string) {
    return this.prisma.liveLocation.findMany({
      where: { employee: { organizationId, deletedAt: null } },
      include: {
        employee: {
          select: { id: true, empCode: true, firstName: true, lastName: true },
        },
      },
      orderBy: { recordedAt: 'desc' },
    });
  }

  async manualEntry(organizationId: string, dto: ManualEntryDto, actingUserId: string) {
    await this.assertEmployeeInOrg(organizationId, dto.employeeId);

    const date = startOfDay(dto.date);
    const checkInAt = dto.checkInAt ? new Date(dto.checkInAt) : null;
    const checkOutAt = dto.checkOutAt ? new Date(dto.checkOutAt) : null;

    let totalHours: number | null = null;
    let overtimeHours: number | null = null;
    if (checkInAt && checkOutAt) {
      totalHours = (checkOutAt.getTime() - checkInAt.getTime()) / MS_PER_HOUR;
      overtimeHours = Math.max(0, totalHours - STANDARD_WORKDAY_HOURS);
    }

    return this.prisma.attendanceLog.upsert({
      where: { employeeId_date: { employeeId: dto.employeeId, date } },
      create: {
        employeeId: dto.employeeId,
        date,
        checkInAt,
        checkOutAt,
        status: dto.status ?? AttendanceStatus.PRESENT,
        source: 'MANUAL',
        totalHours,
        overtimeHours,
        notes: dto.notes,
        approvedBy: actingUserId,
      },
      update: {
        checkInAt,
        checkOutAt,
        status: dto.status ?? undefined,
        source: 'MANUAL',
        totalHours,
        overtimeHours,
        notes: dto.notes,
        approvedBy: actingUserId,
      },
    });
  }

  async bulkImport(organizationId: string, file: Express.Multer.File, actingUserId: string) {
    if (!file) throw new BadRequestException('CSV file is required');

    const rows = this.parseCsv(file.buffer.toString('utf-8'));
    const results: { row: number; empCode: string; status: string; error?: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const employee = await this.prisma.employee.findFirst({
          where: { empCode: row.empCode, organizationId, deletedAt: null },
          select: { id: true },
        });
        if (!employee) {
          results.push({
            row: i + 1,
            empCode: row.empCode,
            status: 'failed',
            error: 'Employee not found',
          });
          continue;
        }

        await this.manualEntry(
          organizationId,
          {
            employeeId: employee.id,
            date: row.date,
            checkInAt: row.checkInAt || undefined,
            checkOutAt: row.checkOutAt || undefined,
            status: (row.status as AttendanceStatus) || undefined,
            notes: row.notes || undefined,
          },
          actingUserId,
        );
        results.push({ row: i + 1, empCode: row.empCode, status: 'imported' });
      } catch (err) {
        results.push({
          row: i + 1,
          empCode: row.empCode,
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return {
      total: rows.length,
      imported: results.filter((r) => r.status === 'imported').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results,
    };
  }

  private parseCsv(content: string): Record<string, string>[] {
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const values = line.split(',').map((v) => v.trim());
      const record: Record<string, string> = {};
      headers.forEach((header, idx) => {
        record[header] = values[idx] ?? '';
      });
      return record;
    });
  }

  async requestCorrection(organizationId: string, employeeId: string, dto: CorrectionRequestDto) {
    await this.assertEmployeeInOrg(organizationId, employeeId);

    const date = startOfDay(dto.date);
    const correctionNote = JSON.stringify({
      type: 'CORRECTION_REQUEST',
      reason: dto.reason,
      requestedCheckIn: dto.requestedCheckIn ?? null,
      requestedCheckOut: dto.requestedCheckOut ?? null,
      requestedAt: new Date().toISOString(),
      requestedBy: employeeId,
    });

    return this.prisma.attendanceLog.upsert({
      where: { employeeId_date: { employeeId, date } },
      create: {
        employeeId,
        date,
        status: AttendanceStatus.ABSENT,
        source: 'MANUAL',
        notes: correctionNote,
      },
      update: {
        notes: correctionNote,
        approvedBy: null,
      },
    });
  }

  async approveCorrection(
    organizationId: string,
    id: string,
    dto: ApproveCorrectionDto,
    approverUserId: string,
    approverEmployeeId: string | null,
  ) {
    const log = await this.prisma.attendanceLog.findFirst({
      where: { id, employee: { organizationId, deletedAt: null } },
    });
    if (!log) throw new NotFoundException('Attendance log not found');
    if (approverEmployeeId && log.employeeId === approverEmployeeId) {
      throw new ForbiddenException('You cannot approve your own attendance correction request');
    }

    const checkInAt = dto.checkInAt ? new Date(dto.checkInAt) : log.checkInAt;
    const checkOutAt = dto.checkOutAt ? new Date(dto.checkOutAt) : log.checkOutAt;

    let totalHours = log.totalHours;
    let overtimeHours = log.overtimeHours;
    if (checkInAt && checkOutAt) {
      totalHours = (checkOutAt.getTime() - checkInAt.getTime()) / MS_PER_HOUR;
      overtimeHours = Math.max(0, totalHours - STANDARD_WORKDAY_HOURS);
    }

    return this.prisma.attendanceLog.update({
      where: { id },
      data: {
        checkInAt,
        checkOutAt,
        status: dto.status ?? log.status,
        notes: dto.notes ?? log.notes,
        totalHours,
        overtimeHours,
        approvedBy: approverUserId,
      },
    });
  }

  async getMyAttendance(organizationId: string, employeeId: string, query: QueryAttendanceDto) {
    await this.assertEmployeeInOrg(organizationId, employeeId);

    const where: Prisma.AttendanceLogWhereInput = {
      employeeId,
      ...this.buildDateFilters(query),
      ...(query.status && { status: query.status }),
    };

    const [data, total] = await Promise.all([
      this.prisma.attendanceLog.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.attendanceLog.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async findAll(organizationId: string, query: QueryAttendanceDto) {
    const where: Prisma.AttendanceLogWhereInput = {
      employee: { organizationId, deletedAt: null },
      ...(query.employeeId && { employeeId: query.employeeId }),
      ...this.buildDateFilters(query),
      ...(query.status && { status: query.status }),
    };

    const [data, total] = await Promise.all([
      this.prisma.attendanceLog.findMany({
        where,
        include: {
          employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
        },
        orderBy: { date: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.attendanceLog.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async findOne(organizationId: string, id: string) {
    const log = await this.prisma.attendanceLog.findFirst({
      where: { id, employee: { organizationId, deletedAt: null } },
      include: {
        employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
      },
    });
    if (!log) throw new NotFoundException('Attendance log not found');
    return log;
  }

  private buildDateFilters(query: QueryAttendanceDto): Prisma.AttendanceLogWhereInput {
    if (query.date) {
      return { date: startOfDay(query.date) };
    }
    if (query.fromDate || query.toDate) {
      return {
        date: {
          ...(query.fromDate && { gte: startOfDay(query.fromDate) }),
          ...(query.toDate && { lte: startOfDay(query.toDate) }),
        },
      };
    }
    return {};
  }
}
