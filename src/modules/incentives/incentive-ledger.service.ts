import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '@common/dto/pagination.dto';
import { QueryIncentiveLedgerDto } from './dto/query-incentive-ledger.dto';
import { ReleaseIncentiveDto } from './dto/release-incentive.dto';
import { RequestingUser, TODO_APPROVE_PERMISSION } from '../todos/todos.service';

export interface ReleasedIncentiveForPeriod {
  totalIncentive: number;
  ledgerIds: string[];
}

const LEDGER_WITH_RELATIONS = {
  employee: {
    select: {
      id: true,
      empCode: true,
      firstName: true,
      lastName: true,
      department: { select: { name: true } },
    },
  },
  todo: {
    select: { id: true, title: true },
  },
} satisfies Prisma.IncentiveLedgerInclude;

type IncentiveLedgerWithRelations = Prisma.IncentiveLedgerGetPayload<{
  include: typeof LEDGER_WITH_RELATIONS;
}>;

@Injectable()
export class IncentiveLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  private hasReadPermission(currentUser: RequestingUser): boolean {
    return (
      currentUser.permissions.includes('payroll:read') ||
      currentUser.permissions.includes(TODO_APPROVE_PERMISSION) ||
      currentUser.permissions.includes('*')
    );
  }

  async findAll(
    organizationId: string,
    currentUser: RequestingUser,
    query: QueryIncentiveLedgerDto,
  ) {
    const canSeeAll = this.hasReadPermission(currentUser);
    const scopedEmployeeId = canSeeAll ? query.employeeId : currentUser.employeeId;

    if (!canSeeAll && !scopedEmployeeId) {
      return paginate([], 0, query);
    }

    const where: Prisma.IncentiveLedgerWhereInput = {
      employee: { organizationId, deletedAt: null },
      ...(scopedEmployeeId && { employeeId: scopedEmployeeId }),
      ...(query.isHeld !== undefined && { isHeld: query.isHeld }),
      ...(query.isReleased !== undefined && { isReleased: query.isReleased }),
      ...(query.payrollMonth !== undefined && { payrollMonth: query.payrollMonth }),
      ...(query.payrollYear !== undefined && { payrollYear: query.payrollYear }),
    };

    const [data, total] = await Promise.all([
      this.prisma.incentiveLedger.findMany({
        where,
        include: LEDGER_WITH_RELATIONS,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.incentiveLedger.count({ where }),
    ]);

    return paginate(
      data.map((entry) => this.toResponse(entry)),
      total,
      query,
    );
  }

  async release(
    organizationId: string,
    userId: string,
    approverEmployeeId: string | null,
    id: string,
    dto: ReleaseIncentiveDto,
  ) {
    const entry = await this.getEntryOrThrow(organizationId, id);

    if (approverEmployeeId && entry.employeeId === approverEmployeeId) {
      throw new ForbiddenException('You cannot release your own incentive ledger entry');
    }

    if (!entry.isHeld || entry.isReleased || entry.isDeducted) {
      throw new BadRequestException(
        'Only a held, not-yet-released, not-yet-deducted incentive ledger entry can be released',
      );
    }

    const updated = await this.prisma.incentiveLedger.update({
      where: { id },
      data: {
        isHeld: false,
        isReleased: true,
        releaseAmount: entry.totalAmount,
        releasedAt: new Date(),
        ...(dto.payrollMonth !== undefined && { payrollMonth: dto.payrollMonth }),
        ...(dto.payrollYear !== undefined && { payrollYear: dto.payrollYear }),
      },
      include: LEDGER_WITH_RELATIONS,
    });

    return this.toResponse(updated);
  }

  /**
   * Consumed by PayrollService.processRun. Returns the sum of released,
   * not-held, not-yet-deducted IncentiveLedger amounts for (employeeId,
   * month, year), plus the ledger row ids to mark as deducted after the
   * payroll entry is persisted. Idempotent: a repeat call for an
   * already-deducted period returns { totalIncentive: 0, ledgerIds: [] }
   * because isDeducted rows are excluded.
   */
  async getReleasedIncentiveForPeriod(
    organizationId: string,
    employeeId: string,
    month: number,
    year: number,
  ): Promise<ReleasedIncentiveForPeriod> {
    const rows = await this.prisma.incentiveLedger.findMany({
      where: {
        employeeId,
        payrollMonth: month,
        payrollYear: year,
        isReleased: true,
        isHeld: false,
        isDeducted: false,
        employee: { organizationId },
      },
      select: { id: true, releaseAmount: true },
    });

    if (rows.length === 0) {
      return { totalIncentive: 0, ledgerIds: [] };
    }

    return {
      totalIncentive: rows.reduce((sum, row) => sum + row.releaseAmount, 0),
      ledgerIds: rows.map((row) => row.id),
    };
  }

  /**
   * Consumed by PayrollService after persisting a PayrollEntry. Flips
   * isDeducted/payrollEntryId on the given ledger rows. No-op on empty
   * array. Idempotent — safe to call repeatedly with the same ledgerIds.
   */
  async markIncentiveDeducted(ledgerIds: string[], payrollEntryId: string): Promise<void> {
    if (ledgerIds.length === 0) return;

    await this.prisma.incentiveLedger.updateMany({
      where: { id: { in: ledgerIds } },
      data: { isDeducted: true, payrollEntryId },
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async getEntryOrThrow(
    organizationId: string,
    id: string,
  ): Promise<IncentiveLedgerWithRelations> {
    const entry = await this.prisma.incentiveLedger.findFirst({
      where: { id, employee: { organizationId } },
      include: LEDGER_WITH_RELATIONS,
    });
    if (!entry) throw new NotFoundException('Incentive ledger entry not found');
    return entry;
  }

  private toResponse(entry: IncentiveLedgerWithRelations) {
    return {
      id: entry.id,
      employeeId: entry.employeeId,
      employee: entry.employee
        ? {
            id: entry.employee.id,
            empCode: entry.employee.empCode,
            firstName: entry.employee.firstName,
            lastName: entry.employee.lastName,
            departmentName: entry.employee.department?.name ?? null,
          }
        : null,
      todoId: entry.todoId,
      todo: entry.todo ? { id: entry.todo.id, title: entry.todo.title } : null,
      source: entry.source,
      totalAmount: entry.totalAmount,
      holdAmount: entry.holdAmount,
      releaseAmount: entry.releaseAmount,
      payrollMonth: entry.payrollMonth,
      payrollYear: entry.payrollYear,
      isHeld: entry.isHeld,
      isReleased: entry.isReleased,
      isDeducted: entry.isDeducted,
      payrollEntryId: entry.payrollEntryId,
      releasedAt: entry.releasedAt,
      createdAt: entry.createdAt,
    };
  }
}
