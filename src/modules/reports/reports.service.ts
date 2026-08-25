import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LeaveStatus, LoanStatus } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import * as PDFDocument from 'pdfkit';
import { PrismaService } from '@prisma/prisma.service';
import { QueryReportDto } from './dto/query-report.dto';
import { ReportExportFormat } from './dto/export-report.dto';

export const REPORT_TYPES = [
  'headcount',
  'attendance',
  'leave',
  'payroll',
  'loans',
  'incentives',
  'attendance-track',
  'performance',
  'todo-incentive',
  'audit',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

interface ExportedFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_CONTENT_TYPE = 'application/pdf';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Validates a departmentId (if supplied) belongs to the caller's organization. Rule #16. */
  private async assertDepartmentInOrg(
    organizationId: string,
    departmentId?: string,
  ): Promise<void> {
    if (!departmentId) return;
    const dept = await this.prisma.department.findFirst({
      where: { id: departmentId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!dept) throw new NotFoundException('Department not found');
  }

  private resolvePeriod(query: QueryReportDto): { from: Date; to: Date } {
    if (query.from || query.to) {
      const from = query.from ? new Date(query.from) : new Date(0);
      const to = query.to ? new Date(query.to) : new Date();
      return { from, to };
    }
    const now = new Date();
    const year = query.year ?? now.getUTCFullYear();
    const month = query.month ?? now.getUTCMonth() + 1;
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    return { from, to };
  }

  // ─── Headcount ──────────────────────────────────────────────────────────────

  async headcount(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);

    const where = {
      organizationId,
      deletedAt: null,
      ...(query.departmentId && { departmentId: query.departmentId }),
    };

    const [total, statusGroups, typeGroups, deptGroups, desigGroups] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.groupBy({ by: ['status'], where, _count: { status: true } }),
      this.prisma.employee.groupBy({
        by: ['employmentType'],
        where,
        _count: { employmentType: true },
      }),
      this.prisma.department.findMany({
        where: {
          organizationId,
          deletedAt: null,
          ...(query.departmentId && { id: query.departmentId }),
        },
        select: {
          id: true,
          name: true,
          _count: { select: { employees: { where: { deletedAt: null } } } },
        },
      }),
      this.prisma.designation.findMany({
        where: {
          organizationId,
          deletedAt: null,
          ...(query.departmentId && { departmentId: query.departmentId }),
        },
        select: {
          id: true,
          name: true,
          _count: { select: { employees: { where: { deletedAt: null } } } },
        },
      }),
    ]);

    return {
      total,
      byDepartment: deptGroups.map((d) => ({
        departmentId: d.id,
        departmentName: d.name,
        count: d._count.employees,
      })),
      byDesignation: desigGroups.map((d) => ({
        designationId: d.id,
        designationName: d.name,
        count: d._count.employees,
      })),
      byEmploymentType: typeGroups.map((g) => ({
        employmentType: g.employmentType,
        count: g._count.employmentType,
      })),
      byStatus: statusGroups.map((g) => ({ status: g.status, count: g._count.status })),
    };
  }

  // ─── Attendance ─────────────────────────────────────────────────────────────

  async attendance(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const { from, to } = this.resolvePeriod(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const employeeFilter = {
      organizationId,
      deletedAt: null,
      ...(query.departmentId && { departmentId: query.departmentId }),
    };

    const logWhere = {
      date: { gte: from, lte: to },
      employee: employeeFilter,
    };

    const statusGroups = await this.prisma.attendanceLog.groupBy({
      by: ['status'],
      where: logWhere,
      _count: { status: true },
    });

    const totalPresent = statusGroups.find((g) => g.status === 'PRESENT')?._count.status ?? 0;
    const totalAbsent = statusGroups.find((g) => g.status === 'ABSENT')?._count.status ?? 0;

    const lopAgg = await this.prisma.payrollEntry.aggregate({
      where: {
        employee: employeeFilter,
        payrollRun: {
          organizationId,
          ...(query.year && { year: query.year }),
          ...(query.month && { month: query.month }),
        },
      },
      _sum: { lopDays: true },
    });

    const leaveAgg = await this.prisma.leaveApplication.aggregate({
      where: {
        employee: employeeFilter,
        status: LeaveStatus.APPROVED,
        fromDate: { lte: to },
        toDate: { gte: from },
      },
      _sum: { days: true },
    });

    const employees = await this.prisma.employee.findMany({
      where: employeeFilter,
      select: { id: true, empCode: true, firstName: true, lastName: true },
      orderBy: { empCode: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const totalEmployees = await this.prisma.employee.count({ where: employeeFilter });

    const rows = await Promise.all(
      employees.map(async (emp) => {
        const [present, absent] = await Promise.all([
          this.prisma.attendanceLog.count({
            where: { employeeId: emp.id, date: { gte: from, lte: to }, status: 'PRESENT' },
          }),
          this.prisma.attendanceLog.count({
            where: { employeeId: emp.id, date: { gte: from, lte: to }, status: 'ABSENT' },
          }),
        ]);
        const [lop, leaveAggForEmp] = await Promise.all([
          this.prisma.payrollEntry.aggregate({
            where: {
              employeeId: emp.id,
              payrollRun: {
                organizationId,
                ...(query.year && { year: query.year }),
                ...(query.month && { month: query.month }),
              },
            },
            _sum: { lopDays: true },
          }),
          this.prisma.leaveApplication.aggregate({
            where: {
              employeeId: emp.id,
              status: LeaveStatus.APPROVED,
              fromDate: { lte: to },
              toDate: { gte: from },
            },
            _sum: { days: true },
          }),
        ]);
        return {
          employeeId: emp.id,
          empCode: emp.empCode,
          name: `${emp.firstName} ${emp.lastName}`,
          presentDays: present,
          absentDays: absent,
          leaveDays: leaveAggForEmp._sum.days ?? 0,
          lopDays: lop._sum.lopDays ?? 0,
        };
      }),
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalPresent,
      totalAbsent,
      totalLeave: leaveAgg._sum.days ?? 0,
      totalLop: lopAgg._sum.lopDays ?? 0,
      byStatus: statusGroups.map((g) => ({ status: g.status, count: g._count.status })),
      rows,
      meta: {
        total: totalEmployees,
        page,
        limit,
        totalPages: Math.ceil(totalEmployees / limit),
      },
    };
  }

  // ─── Leave ──────────────────────────────────────────────────────────────────

  async leave(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const year = query.year ?? new Date().getUTCFullYear();
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const employeeFilter = {
      organizationId,
      deletedAt: null,
      ...(query.departmentId && { departmentId: query.departmentId }),
    };

    const [pendingApplications, total, balances] = await Promise.all([
      this.prisma.leaveApplication.count({
        where: { status: LeaveStatus.PENDING, employee: employeeFilter },
      }),
      this.prisma.leaveBalance.count({ where: { year, employee: employeeFilter } }),
      this.prisma.leaveBalance.findMany({
        where: { year, employee: employeeFilter },
        include: {
          employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
          leavePolicyType: { select: { leaveType: true } },
        },
        orderBy: { employee: { empCode: 'asc' } },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      year,
      pendingApplications,
      rows: balances.map((b) => ({
        employeeId: b.employee.id,
        empCode: b.employee.empCode,
        name: `${b.employee.firstName} ${b.employee.lastName}`,
        leavePolicyTypeId: b.leavePolicyTypeId,
        leaveType: b.leavePolicyType.leaveType,
        entitledDays: b.entitledDays,
        takenDays: b.takenDays,
        balanceDays: b.balanceDays,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Payroll ────────────────────────────────────────────────────────────────

  async payroll(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const run =
      query.month && query.year
        ? await this.prisma.payrollRun.findUnique({
            where: {
              organizationId_month_year: { organizationId, month: query.month, year: query.year },
            },
          })
        : await this.prisma.payrollRun.findFirst({
            where: { organizationId },
            orderBy: [{ year: 'desc' }, { month: 'desc' }],
          });

    if (!run) {
      const now = new Date();
      return {
        runId: null,
        month: query.month ?? now.getUTCMonth() + 1,
        year: query.year ?? now.getUTCFullYear(),
        status: null,
        employeeCount: 0,
        totalGross: 0,
        totalDisbursed: 0,
        componentBreakdown: this.emptyComponentBreakdown(),
        rows: [],
        meta: { total: 0, page, limit, totalPages: 0 },
      };
    }

    const entryWhere = {
      payrollRunId: run.id,
      ...(query.departmentId && { employee: { departmentId: query.departmentId } }),
    };

    const [count, agg, entries] = await Promise.all([
      this.prisma.payrollEntry.count({ where: entryWhere }),
      this.prisma.payrollEntry.aggregate({
        where: entryWhere,
        _sum: {
          grossSalary: true,
          netSalary: true,
          basicSalary: true,
          hra: true,
          specialAllowance: true,
          educationAllowance: true,
          otherAllowances: true,
          incentiveAmount: true,
          overtimeAmount: true,
          travelAllowance: true,
          bonus: true,
          greenThanksAmount: true,
          pfEmployee: true,
          pfEmployer: true,
          esiEmployee: true,
          esiEmployer: true,
          professionalTax: true,
          tds: true,
          loanDeduction: true,
          advanceDeduction: true,
          otherDeductions: true,
        },
      }),
      this.prisma.payrollEntry.findMany({
        where: entryWhere,
        include: {
          employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
        },
        orderBy: { employee: { empCode: 'asc' } },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      runId: run.id,
      month: run.month,
      year: run.year,
      status: run.status,
      employeeCount: count,
      totalGross: agg._sum.grossSalary ?? 0,
      totalDisbursed: agg._sum.netSalary ?? 0,
      componentBreakdown: {
        basicSalary: agg._sum.basicSalary ?? 0,
        hra: agg._sum.hra ?? 0,
        specialAllowance: agg._sum.specialAllowance ?? 0,
        educationAllowance: agg._sum.educationAllowance ?? 0,
        otherAllowances: agg._sum.otherAllowances ?? 0,
        incentiveAmount: agg._sum.incentiveAmount ?? 0,
        overtimeAmount: agg._sum.overtimeAmount ?? 0,
        travelAllowance: agg._sum.travelAllowance ?? 0,
        bonus: agg._sum.bonus ?? 0,
        greenThanksAmount: agg._sum.greenThanksAmount ?? 0,
        pfEmployee: agg._sum.pfEmployee ?? 0,
        pfEmployer: agg._sum.pfEmployer ?? 0,
        esiEmployee: agg._sum.esiEmployee ?? 0,
        esiEmployer: agg._sum.esiEmployer ?? 0,
        professionalTax: agg._sum.professionalTax ?? 0,
        tds: agg._sum.tds ?? 0,
        loanDeduction: agg._sum.loanDeduction ?? 0,
        advanceDeduction: agg._sum.advanceDeduction ?? 0,
        otherDeductions: agg._sum.otherDeductions ?? 0,
      },
      rows: entries.map((e) => ({
        employeeId: e.employee.id,
        empCode: e.employee.empCode,
        name: `${e.employee.firstName} ${e.employee.lastName}`,
        basicSalary: e.basicSalary,
        hra: e.hra,
        specialAllowance: e.specialAllowance,
        educationAllowance: e.educationAllowance,
        otherAllowances: e.otherAllowances,
        incentiveAmount: e.incentiveAmount,
        overtimeAmount: e.overtimeAmount,
        travelAllowance: e.travelAllowance,
        bonus: e.bonus,
        greenThanksAmount: e.greenThanksAmount,
        grossSalary: e.grossSalary,
        pfEmployee: e.pfEmployee,
        pfEmployer: e.pfEmployer,
        esiEmployee: e.esiEmployee,
        esiEmployer: e.esiEmployer,
        professionalTax: e.professionalTax,
        tds: e.tds,
        loanDeduction: e.loanDeduction,
        advanceDeduction: e.advanceDeduction,
        otherDeductions: e.otherDeductions,
        netSalary: e.netSalary,
      })),
      meta: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
    };
  }

  private emptyComponentBreakdown() {
    return {
      basicSalary: 0,
      hra: 0,
      specialAllowance: 0,
      educationAllowance: 0,
      otherAllowances: 0,
      incentiveAmount: 0,
      overtimeAmount: 0,
      travelAllowance: 0,
      bonus: 0,
      greenThanksAmount: 0,
      pfEmployee: 0,
      pfEmployer: 0,
      esiEmployee: 0,
      esiEmployer: 0,
      professionalTax: 0,
      tds: 0,
      loanDeduction: 0,
      advanceDeduction: 0,
      otherDeductions: 0,
    };
  }

  // ─── Loans ──────────────────────────────────────────────────────────────────

  /**
   * Remaining principal+interest for a loan: the outstandingBalance of the
   * earliest not-yet-deducted EMI row (mirrors LoansService.getOutstandingBalanceForEmployee).
   */
  private async loanOutstandingBalance(loanId: string): Promise<number> {
    const nextInstallment = await this.prisma.loanEmiSchedule.findFirst({
      where: { loanId, isDeducted: false },
      orderBy: [{ emiYear: 'asc' }, { emiMonth: 'asc' }],
      select: { outstandingBalance: true },
    });
    return nextInstallment?.outstandingBalance ?? 0;
  }

  async loans(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const employeeFilter = {
      organizationId,
      ...(query.departmentId && { departmentId: query.departmentId }),
    };

    const [activeLoanCount, total, loans] = await Promise.all([
      this.prisma.loanApplication.count({
        where: { status: LoanStatus.ACTIVE, employee: employeeFilter },
      }),
      this.prisma.loanApplication.count({ where: { employee: employeeFilter } }),
      this.prisma.loanApplication.findMany({
        where: { employee: employeeFilter },
        include: {
          employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const rows = await Promise.all(
      loans.map(async (loan) => ({
        loanId: loan.id,
        employeeId: loan.employee.id,
        empCode: loan.employee.empCode,
        name: `${loan.employee.firstName} ${loan.employee.lastName}`,
        amountRequested: loan.amountRequested,
        amountApproved: loan.amountApproved,
        status: loan.status,
        outstandingBalance:
          loan.status === LoanStatus.ACTIVE ? await this.loanOutstandingBalance(loan.id) : 0,
      })),
    );

    const activeLoans = await this.prisma.loanApplication.findMany({
      where: { status: LoanStatus.ACTIVE, employee: employeeFilter },
      select: { id: true },
    });
    const outstandingBalances = await Promise.all(
      activeLoans.map((l) => this.loanOutstandingBalance(l.id)),
    );
    const totalOutstanding = outstandingBalances.reduce((sum, v) => sum + v, 0);

    return {
      activeLoanCount,
      totalOutstanding,
      rows,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Incentives ─────────────────────────────────────────────────────────────

  async incentives(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const employeeFilter = {
      organizationId,
      ...(query.departmentId && { departmentId: query.departmentId }),
    };

    const ledgerWhere = {
      employee: employeeFilter,
      ...(query.month && { payrollMonth: query.month }),
      ...(query.year && { payrollYear: query.year }),
    };

    const grouped = await this.prisma.incentiveLedger.groupBy({
      by: ['employeeId', 'payrollMonth', 'payrollYear'],
      where: ledgerWhere,
      _sum: { totalAmount: true },
      orderBy: [{ payrollYear: 'desc' }, { payrollMonth: 'desc' }],
    });

    const totalAgg = await this.prisma.incentiveLedger.aggregate({
      where: ledgerWhere,
      _sum: { totalAmount: true },
    });

    const total = grouped.length;
    const page_ = grouped.slice((page - 1) * limit, (page - 1) * limit + limit);

    const employeeIds = [...new Set(page_.map((g) => g.employeeId))];
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, empCode: true, firstName: true, lastName: true },
    });
    const employeeMap = new Map(employees.map((e) => [e.id, e]));

    return {
      month: query.month ?? null,
      year: query.year ?? null,
      totalAmount: totalAgg._sum.totalAmount ?? 0,
      rows: page_.map((g) => {
        const emp = employeeMap.get(g.employeeId);
        return {
          employeeId: g.employeeId,
          empCode: emp?.empCode ?? '',
          name: emp ? `${emp.firstName} ${emp.lastName}` : '',
          payrollMonth: g.payrollMonth,
          payrollYear: g.payrollYear,
          totalAmount: g._sum.totalAmount ?? 0,
        };
      }),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Attendance & Live Track ────────────────────────────────────────────────

  async attendanceTrack(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const { from, to } = this.resolvePeriod(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const employeeFilter = {
      organizationId,
      deletedAt: null,
      ...(query.departmentId && { departmentId: query.departmentId }),
    };

    const logWhere = {
      date: { gte: from, lte: to },
      employee: employeeFilter,
    };

    const [total, logs] = await Promise.all([
      this.prisma.attendanceLog.count({ where: logWhere }),
      this.prisma.attendanceLog.findMany({
        where: logWhere,
        include: {
          employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
        },
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const LIVE_WINDOW_MINUTES = 30;
    const LIVE_NOW_CAP = 200;
    const liveWindowStart = new Date(Date.now() - LIVE_WINDOW_MINUTES * 60 * 1000);

    const recentLocations = await this.prisma.liveLocation.findMany({
      where: { recordedAt: { gte: liveWindowStart }, employee: employeeFilter },
      include: {
        employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
      },
      orderBy: { recordedAt: 'desc' },
      take: 2000,
    });

    const seenEmployeeIds = new Set<string>();
    const liveNow: {
      employeeId: string;
      empCode: string;
      name: string;
      lat: number;
      lng: number;
      recordedAt: string;
    }[] = [];
    for (const loc of recentLocations) {
      if (seenEmployeeIds.has(loc.employeeId)) continue;
      seenEmployeeIds.add(loc.employeeId);
      liveNow.push({
        employeeId: loc.employee.id,
        empCode: loc.employee.empCode,
        name: `${loc.employee.firstName} ${loc.employee.lastName}`,
        lat: loc.lat,
        lng: loc.lng,
        recordedAt: loc.recordedAt.toISOString(),
      });
      if (liveNow.length >= LIVE_NOW_CAP) break;
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      rows: logs.map((log) => ({
        employeeId: log.employee.id,
        empCode: log.employee.empCode,
        name: `${log.employee.firstName} ${log.employee.lastName}`,
        date: log.date.toISOString(),
        checkInAt: log.checkInAt?.toISOString() ?? null,
        checkOutAt: log.checkOutAt?.toISOString() ?? null,
        checkInLat: log.checkInLat,
        checkInLng: log.checkInLng,
        checkInLocationName: log.checkInLocationName,
        checkOutLat: log.checkOutLat,
        checkOutLng: log.checkOutLng,
        checkOutLocationName: log.checkOutLocationName,
        source: log.source,
        status: log.status,
        totalHours: log.totalHours,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      liveNow,
    };
  }

  // ─── Performance ────────────────────────────────────────────────────────────

  async performance(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const { from, to } = this.resolvePeriod(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const employeeFilter = {
      organizationId,
      deletedAt: null,
      ...(query.departmentId && { departmentId: query.departmentId }),
    };

    const ratingWhere = {
      cycle: { organizationId },
      submittedAt: { gte: from, lte: to },
      employee: employeeFilter,
    };

    const [total, avgAgg, ratings] = await Promise.all([
      this.prisma.performanceRating.count({ where: ratingWhere }),
      this.prisma.performanceRating.aggregate({ where: ratingWhere, _avg: { rating: true } }),
      this.prisma.performanceRating.findMany({
        where: ratingWhere,
        include: {
          employee: { select: { id: true, empCode: true, firstName: true, lastName: true } },
          cycle: { select: { id: true, name: true } },
        },
        orderBy: { submittedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const rows = await Promise.all(
      ratings.map(async (r) => {
        const [kpiAssignedCount, kpiAchievedCount] = await Promise.all([
          this.prisma.employeeKpi.count({ where: { employeeId: r.employeeId } }),
          this.prisma.employeeKpi.count({
            where: { employeeId: r.employeeId, status: 'ACHIEVED' },
          }),
        ]);
        return {
          employeeId: r.employee.id,
          empCode: r.employee.empCode,
          name: `${r.employee.firstName} ${r.employee.lastName}`,
          cycleId: r.cycle.id,
          cycleName: r.cycle.name,
          rating: r.rating,
          isEligibleForIncrement: r.isEligibleForIncrement,
          ratedBy: r.ratedBy,
          submittedAt: r.submittedAt.toISOString(),
          kpiAssignedCount,
          kpiAchievedCount,
          kpiAchievementRate: kpiAssignedCount > 0 ? kpiAchievedCount / kpiAssignedCount : 0,
        };
      }),
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      avgRating: avgAgg._avg.rating ?? 0,
      totalRatingsCount: total,
      rows,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Todo & Incentive ───────────────────────────────────────────────────────

  async todoIncentive(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const { from, to } = this.resolvePeriod(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const employeeFilter = {
      organizationId,
      deletedAt: null,
      ...(query.departmentId && { departmentId: query.departmentId }),
    };

    const ledgerFilter = {
      ...(query.month && { payrollMonth: query.month }),
      ...(query.year && { payrollYear: query.year }),
    };

    const [totalEmployees, employees, orgTodosApproved, orgIncentiveAgg] = await Promise.all([
      this.prisma.employee.count({ where: employeeFilter }),
      this.prisma.employee.findMany({
        where: employeeFilter,
        select: { id: true, empCode: true, firstName: true, lastName: true },
        orderBy: { empCode: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.todoTask.count({
        where: {
          status: 'APPROVED',
          submittedAt: { gte: from, lte: to },
          employee: employeeFilter,
        },
      }),
      this.prisma.incentiveLedger.aggregate({
        where: { employee: employeeFilter, ...ledgerFilter },
        _sum: { totalAmount: true },
      }),
    ]);

    const rows = await Promise.all(
      employees.map(async (emp) => {
        const todoDateFilter = { employeeId: emp.id, submittedAt: { gte: from, lte: to } };
        const [todosTotal, todosApproved, todosRejected, incentiveAgg] = await Promise.all([
          this.prisma.todoTask.count({ where: todoDateFilter }),
          this.prisma.todoTask.count({ where: { ...todoDateFilter, status: 'APPROVED' } }),
          this.prisma.todoTask.count({ where: { ...todoDateFilter, status: 'REJECTED' } }),
          this.prisma.incentiveLedger.aggregate({
            where: { employeeId: emp.id, ...ledgerFilter },
            _sum: { totalAmount: true, releaseAmount: true },
          }),
        ]);
        return {
          employeeId: emp.id,
          empCode: emp.empCode,
          name: `${emp.firstName} ${emp.lastName}`,
          todosTotal,
          todosApproved,
          todosRejected,
          completionRate: todosTotal > 0 ? todosApproved / todosTotal : 0,
          incentiveTotalAmount: incentiveAgg._sum.totalAmount ?? 0,
          incentiveReleasedAmount: incentiveAgg._sum.releaseAmount ?? 0,
        };
      }),
    );

    return {
      orgTodosApproved,
      orgIncentiveTotalAmount: orgIncentiveAgg._sum.totalAmount ?? 0,
      rows,
      meta: {
        total: totalEmployees,
        page,
        limit,
        totalPages: Math.ceil(totalEmployees / limit),
      },
    };
  }

  // ─── Audit / Login History ──────────────────────────────────────────────────

  async auditHistory(organizationId: string, query: QueryReportDto) {
    await this.assertDepartmentInOrg(organizationId, query.departmentId);
    const { from, to } = this.resolvePeriod(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const AUDIT_LOG_CAP = 100;

    const userWhere = {
      organizationId,
      ...(query.departmentId && { employee: { departmentId: query.departmentId } }),
    };

    const loginWhere = {
      loginAt: { gte: from, lte: to },
      user: userWhere,
    };

    const [total, failedLogins, uniqueUserRows, rows, systemChanges] = await Promise.all([
      this.prisma.loginHistory.count({ where: loginWhere }),
      this.prisma.loginHistory.count({ where: { ...loginWhere, status: { not: 'success' } } }),
      this.prisma.loginHistory.findMany({
        where: loginWhere,
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.loginHistory.findMany({
        where: loginWhere,
        include: {
          user: {
            include: {
              employee: { select: { empCode: true, firstName: true, lastName: true } },
            },
          },
        },
        orderBy: { loginAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.findMany({
        where: { organizationId, occurredAt: { gte: from, lte: to } },
        orderBy: { occurredAt: 'desc' },
        take: AUDIT_LOG_CAP,
      }),
    ]);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalLogins: total,
      failedLogins,
      uniqueUsers: uniqueUserRows.length,
      rows: rows.map((r) => ({
        userId: r.userId,
        email: r.user.email,
        empCode: r.user.employee?.empCode ?? null,
        name: r.user.employee
          ? `${r.user.employee.firstName} ${r.user.employee.lastName}`
          : r.user.email,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        deviceInfo: r.deviceInfo,
        loginAt: r.loginAt.toISOString(),
        logoutAt: r.logoutAt?.toISOString() ?? null,
        status: r.status,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      systemChanges: systemChanges.map((a) => ({
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        actorId: a.actorId,
        occurredAt: a.occurredAt.toISOString(),
        ipAddress: a.ipAddress,
      })),
    };
  }

  // ─── Export ─────────────────────────────────────────────────────────────────

  async export(
    organizationId: string,
    type: string,
    format: ReportExportFormat | undefined,
    query: QueryReportDto,
  ): Promise<ExportedFile> {
    if (!REPORT_TYPES.includes(type as ReportType)) {
      throw new BadRequestException(
        `Unknown report type '${type}'. Expected one of: ${REPORT_TYPES.join(', ')}`,
      );
    }
    const resolvedFormat: ReportExportFormat = format ?? 'excel';
    if (resolvedFormat !== 'excel' && resolvedFormat !== 'pdf') {
      throw new BadRequestException("format must be 'excel' or 'pdf'");
    }

    const reportType = type as ReportType;
    const timestamp = new Date().toISOString().slice(0, 10);

    const PDF_SUPPORTED_TYPES: ReportType[] = [
      'payroll',
      'attendance-track',
      'performance',
      'todo-incentive',
      'attendance',
      'audit',
    ];

    if (resolvedFormat === 'pdf') {
      if (!PDF_SUPPORTED_TYPES.includes(reportType)) {
        throw new BadRequestException(
          `PDF export is not yet implemented for '${reportType}' reports — only ` +
            `${PDF_SUPPORTED_TYPES.join(', ')} support PDF today. Use format=excel, or see the ` +
            'follow-up ticket to extend pdfkit generation to the remaining report types.',
        );
      }

      const fullQuery = { ...query, page: 1, limit: 100000 } as QueryReportDto;
      let buffer: Buffer;
      if (reportType === 'payroll') {
        buffer = await this.buildPayrollPdf(await this.payroll(organizationId, fullQuery));
      } else if (reportType === 'attendance-track') {
        buffer = await this.buildAttendanceTrackPdf(
          await this.attendanceTrack(organizationId, fullQuery),
        );
      } else if (reportType === 'performance') {
        buffer = await this.buildPerformancePdf(await this.performance(organizationId, fullQuery));
      } else if (reportType === 'attendance') {
        buffer = await this.buildAttendancePdf(await this.attendance(organizationId, fullQuery));
      } else if (reportType === 'audit') {
        buffer = await this.buildAuditPdf(await this.auditHistory(organizationId, fullQuery));
      } else {
        buffer = await this.buildTodoIncentivePdf(
          await this.todoIncentive(organizationId, fullQuery),
        );
      }

      return {
        buffer,
        filename: `${reportType}-report-${timestamp}.pdf`,
        contentType: PDF_CONTENT_TYPE,
      };
    }

    const buffer = await this.buildExcel(organizationId, reportType, query);
    return {
      buffer,
      filename: `${reportType}-report-${timestamp}.xlsx`,
      contentType: EXCEL_CONTENT_TYPE,
    };
  }

  private async buildExcel(
    organizationId: string,
    type: ReportType,
    query: QueryReportDto,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(type);

    switch (type) {
      case 'headcount': {
        const data = await this.headcount(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Department', key: 'department', width: 25 },
          { header: 'Count', key: 'count', width: 10 },
        ];
        sheet.addRow({ department: 'TOTAL', count: data.total });
        for (const d of data.byDepartment) {
          sheet.addRow({ department: d.departmentName, count: d.count });
        }
        break;
      }
      case 'attendance': {
        const data = await this.attendance(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Present Days', key: 'presentDays', width: 15 },
          { header: 'Absent Days', key: 'absentDays', width: 15 },
          { header: 'Leave Days', key: 'leaveDays', width: 14 },
          { header: 'LOP Days', key: 'lopDays', width: 12 },
        ];
        data.rows.forEach((r) => sheet.addRow(r));
        break;
      }
      case 'leave': {
        const data = await this.leave(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Leave Type', key: 'leaveType', width: 15 },
          { header: 'Entitled Days', key: 'entitledDays', width: 15 },
          { header: 'Taken Days', key: 'takenDays', width: 15 },
          { header: 'Balance Days', key: 'balanceDays', width: 15 },
        ];
        data.rows.forEach((r) => sheet.addRow(r));
        break;
      }
      case 'payroll': {
        const data = await this.payroll(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Component', key: 'component', width: 25 },
          { header: 'Amount', key: 'amount', width: 15 },
        ];
        sheet.addRow({ component: 'Total Gross', amount: data.totalGross });
        sheet.addRow({ component: 'Total Disbursed (Net)', amount: data.totalDisbursed });
        for (const [key, value] of Object.entries(data.componentBreakdown)) {
          sheet.addRow({ component: key, amount: value });
        }

        const employeeSheet = workbook.addWorksheet('Payroll Employees');
        employeeSheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Basic Salary', key: 'basicSalary', width: 14 },
          { header: 'HRA', key: 'hra', width: 12 },
          { header: 'Special Allowance', key: 'specialAllowance', width: 16 },
          { header: 'Education Allowance', key: 'educationAllowance', width: 18 },
          { header: 'Other Allowances', key: 'otherAllowances', width: 16 },
          { header: 'Incentive Amount', key: 'incentiveAmount', width: 16 },
          { header: 'Overtime Amount', key: 'overtimeAmount', width: 16 },
          { header: 'Travel Allowance', key: 'travelAllowance', width: 16 },
          { header: 'Bonus', key: 'bonus', width: 12 },
          { header: 'Green Thanks Amount', key: 'greenThanksAmount', width: 18 },
          { header: 'Gross Salary', key: 'grossSalary', width: 14 },
          { header: 'PF (Employee)', key: 'pfEmployee', width: 14 },
          { header: 'PF (Employer)', key: 'pfEmployer', width: 14 },
          { header: 'ESI (Employee)', key: 'esiEmployee', width: 14 },
          { header: 'ESI (Employer)', key: 'esiEmployer', width: 14 },
          { header: 'Professional Tax', key: 'professionalTax', width: 16 },
          { header: 'TDS', key: 'tds', width: 12 },
          { header: 'Loan Deduction', key: 'loanDeduction', width: 16 },
          { header: 'Advance Deduction', key: 'advanceDeduction', width: 16 },
          { header: 'Other Deductions', key: 'otherDeductions', width: 16 },
          { header: 'Net Salary', key: 'netSalary', width: 14 },
        ];
        data.rows.forEach((r) => employeeSheet.addRow(r));
        employeeSheet.getRow(1).font = { bold: true };
        break;
      }
      case 'loans': {
        const data = await this.loans(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Amount Requested', key: 'amountRequested', width: 18 },
          { header: 'Amount Approved', key: 'amountApproved', width: 18 },
          { header: 'Status', key: 'status', width: 12 },
          { header: 'Outstanding Balance', key: 'outstandingBalance', width: 18 },
        ];
        data.rows.forEach((r) => sheet.addRow(r));
        break;
      }
      case 'incentives': {
        const data = await this.incentives(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Month', key: 'payrollMonth', width: 10 },
          { header: 'Year', key: 'payrollYear', width: 10 },
          { header: 'Total Amount', key: 'totalAmount', width: 15 },
        ];
        data.rows.forEach((r) => sheet.addRow(r));
        break;
      }
      case 'attendance-track': {
        const data = await this.attendanceTrack(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Check In', key: 'checkInAt', width: 20 },
          { header: 'Check Out', key: 'checkOutAt', width: 20 },
          { header: 'Check In Lat', key: 'checkInLat', width: 14 },
          { header: 'Check In Lng', key: 'checkInLng', width: 14 },
          { header: 'Check In Location', key: 'checkInLocationName', width: 25 },
          { header: 'Check Out Lat', key: 'checkOutLat', width: 14 },
          { header: 'Check Out Lng', key: 'checkOutLng', width: 14 },
          { header: 'Check Out Location', key: 'checkOutLocationName', width: 25 },
          { header: 'Source', key: 'source', width: 12 },
          { header: 'Status', key: 'status', width: 12 },
          { header: 'Total Hours', key: 'totalHours', width: 12 },
        ];
        data.rows.forEach((r) => sheet.addRow(r));

        const liveSheet = workbook.addWorksheet('Live Now');
        liveSheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Lat', key: 'lat', width: 14 },
          { header: 'Lng', key: 'lng', width: 14 },
          { header: 'Recorded At', key: 'recordedAt', width: 22 },
        ];
        data.liveNow.forEach((r) => liveSheet.addRow(r));
        liveSheet.getRow(1).font = { bold: true };
        break;
      }
      case 'performance': {
        const data = await this.performance(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Cycle', key: 'cycleName', width: 20 },
          { header: 'Rating', key: 'rating', width: 10 },
          { header: 'Eligible For Increment', key: 'isEligibleForIncrement', width: 20 },
          { header: 'Rated By', key: 'ratedBy', width: 20 },
          { header: 'Submitted At', key: 'submittedAt', width: 22 },
          { header: 'KPIs Assigned', key: 'kpiAssignedCount', width: 15 },
          { header: 'KPIs Achieved', key: 'kpiAchievedCount', width: 15 },
          { header: 'KPI Achievement Rate', key: 'kpiAchievementRate', width: 18 },
        ];
        data.rows.forEach((r) => sheet.addRow(r));
        break;
      }
      case 'todo-incentive': {
        const data = await this.todoIncentive(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Todos Total', key: 'todosTotal', width: 14 },
          { header: 'Todos Approved', key: 'todosApproved', width: 16 },
          { header: 'Todos Rejected', key: 'todosRejected', width: 16 },
          { header: 'Completion Rate', key: 'completionRate', width: 16 },
          { header: 'Incentive Total', key: 'incentiveTotalAmount', width: 16 },
          { header: 'Incentive Released', key: 'incentiveReleasedAmount', width: 18 },
        ];
        data.rows.forEach((r) => sheet.addRow(r));
        break;
      }
      case 'audit': {
        const data = await this.auditHistory(organizationId, {
          ...query,
          page: 1,
          limit: 100000,
        } as QueryReportDto);
        sheet.columns = [
          { header: 'Email', key: 'email', width: 25 },
          { header: 'Emp Code', key: 'empCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'IP Address', key: 'ipAddress', width: 18 },
          { header: 'Device Info', key: 'deviceInfo', width: 20 },
          { header: 'Login At', key: 'loginAt', width: 22 },
          { header: 'Logout At', key: 'logoutAt', width: 22 },
          { header: 'Status', key: 'status', width: 12 },
        ];
        data.rows.forEach((r) => sheet.addRow(r));

        const changesSheet = workbook.addWorksheet('System Changes');
        changesSheet.columns = [
          { header: 'Action', key: 'action', width: 20 },
          { header: 'Entity Type', key: 'entityType', width: 18 },
          { header: 'Entity Id', key: 'entityId', width: 24 },
          { header: 'Actor Id', key: 'actorId', width: 24 },
          { header: 'Occurred At', key: 'occurredAt', width: 22 },
          { header: 'IP Address', key: 'ipAddress', width: 18 },
        ];
        data.systemChanges.forEach((r) => changesSheet.addRow(r));
        changesSheet.getRow(1).font = { bold: true };
        break;
      }
    }

    sheet.getRow(1).font = { bold: true };
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  private buildPayrollPdf(data: Awaited<ReturnType<ReportsService['payroll']>>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('Payroll Summary Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(11);
      doc.text(`Period: ${data.month}/${data.year}`);
      doc.text(`Run status: ${data.status ?? 'N/A'}`);
      doc.text(`Employees paid: ${data.employeeCount}`);
      doc.moveDown();
      doc.fontSize(13).text('Totals', { underline: true });
      doc.fontSize(11);
      doc.text(`Total gross salary: ${data.totalGross.toFixed(2)}`);
      doc.text(`Total net disbursed: ${data.totalDisbursed.toFixed(2)}`);
      doc.moveDown();
      doc.fontSize(13).text('Component Breakdown', { underline: true });
      doc.fontSize(11);
      for (const [key, value] of Object.entries(data.componentBreakdown)) {
        doc.text(`${key}: ${Number(value).toFixed(2)}`);
      }

      doc.moveDown();
      doc.fontSize(13).text('Per-Employee Breakdown', { underline: true });
      doc.fontSize(9);
      for (const r of data.rows) {
        doc.text(
          `${r.empCode} — ${r.name} | Gross: ${r.grossSalary.toFixed(2)} | Net: ${r.netSalary.toFixed(2)} | ` +
            `PF(E): ${r.pfEmployee.toFixed(2)} | ESI(E): ${r.esiEmployee.toFixed(2)} | TDS: ${r.tds.toFixed(2)} | ` +
            `Loan Ded: ${r.loanDeduction.toFixed(2)} | Other Ded: ${r.otherDeductions.toFixed(2)}`,
        );
      }

      doc.end();
    });
  }

  private buildAttendanceTrackPdf(
    data: Awaited<ReturnType<ReportsService['attendanceTrack']>>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('Attendance & Live Track Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(11);
      doc.text(`Period: ${data.from} to ${data.to}`);
      doc.text(`Attendance log rows: ${data.rows.length}`);
      doc.text(`Employees live (last 30 min): ${data.liveNow.length}`);
      doc.moveDown();
      doc.fontSize(13).text('Attendance Logs', { underline: true });
      doc.fontSize(9);
      for (const r of data.rows) {
        doc.text(
          `${r.empCode} — ${r.name} | ${r.date.slice(0, 10)} | In: ${r.checkInAt ?? 'N/A'} @ ` +
            `${r.checkInLocationName ?? 'N/A'} | Out: ${r.checkOutAt ?? 'N/A'} @ ` +
            `${r.checkOutLocationName ?? 'N/A'} | Status: ${r.status} | Hours: ${r.totalHours ?? 'N/A'}`,
        );
      }
      doc.moveDown();
      doc.fontSize(13).text('Live Now', { underline: true });
      doc.fontSize(9);
      for (const r of data.liveNow) {
        doc.text(`${r.empCode} — ${r.name} | ${r.lat}, ${r.lng} | ${r.recordedAt}`);
      }

      doc.end();
    });
  }

  private buildAttendancePdf(
    data: Awaited<ReturnType<ReportsService['attendance']>>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('Attendance Summary Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(11);
      doc.text(`Period: ${data.from} to ${data.to}`);
      doc.moveDown();
      doc.fontSize(13).text('Totals', { underline: true });
      doc.fontSize(11);
      doc.text(`Total present: ${data.totalPresent}`);
      doc.text(`Total absent: ${data.totalAbsent}`);
      doc.text(`Total leave: ${data.totalLeave}`);
      doc.text(`Total LOP: ${data.totalLop}`);
      doc.moveDown();
      doc.fontSize(13).text('Per-Employee Breakdown', { underline: true });
      doc.fontSize(9);
      for (const r of data.rows) {
        doc.text(
          `${r.empCode} — ${r.name} | Present: ${r.presentDays} | Absent: ${r.absentDays} | ` +
            `Leave: ${r.leaveDays} | LOP: ${r.lopDays}`,
        );
      }

      doc.end();
    });
  }

  private buildAuditPdf(
    data: Awaited<ReturnType<ReportsService['auditHistory']>>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('Audit Login & History Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(11);
      doc.text(`Period: ${data.from} to ${data.to}`);
      doc.text(`Total logins: ${data.totalLogins}`);
      doc.text(`Failed logins: ${data.failedLogins}`);
      doc.text(`Unique users: ${data.uniqueUsers}`);
      doc.moveDown();
      doc.fontSize(13).text('Login History', { underline: true });
      doc.fontSize(9);
      for (const r of data.rows) {
        doc.text(
          `${r.email} | ${r.empCode ?? 'N/A'} — ${r.name} | IP: ${r.ipAddress ?? 'N/A'} | ` +
            `In: ${r.loginAt} | Out: ${r.logoutAt ?? 'N/A'} | Status: ${r.status}`,
        );
      }
      doc.moveDown();
      doc.fontSize(13).text('System Changes', { underline: true });
      doc.fontSize(9);
      for (const a of data.systemChanges) {
        doc.text(`${a.action} | ${a.entityType} | Actor: ${a.actorId ?? 'N/A'} | ${a.occurredAt}`);
      }

      doc.end();
    });
  }

  private buildPerformancePdf(
    data: Awaited<ReturnType<ReportsService['performance']>>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('Performance Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(11);
      doc.text(`Period: ${data.from} to ${data.to}`);
      doc.text(`Average rating: ${data.avgRating.toFixed(2)}`);
      doc.text(`Total ratings: ${data.totalRatingsCount}`);
      doc.moveDown();
      doc.fontSize(13).text('Per-Employee Ratings', { underline: true });
      doc.fontSize(9);
      for (const r of data.rows) {
        doc.text(
          `${r.empCode} — ${r.name} | Cycle: ${r.cycleName} | Rating: ${r.rating} | ` +
            `Increment eligible: ${r.isEligibleForIncrement} | KPIs: ${r.kpiAchievedCount}/${r.kpiAssignedCount} ` +
            `(${(r.kpiAchievementRate * 100).toFixed(0)}%)`,
        );
      }

      doc.end();
    });
  }

  private buildTodoIncentivePdf(
    data: Awaited<ReturnType<ReportsService['todoIncentive']>>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).text('Todo & Incentive Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(11);
      doc.text(`Org-wide todos approved: ${data.orgTodosApproved}`);
      doc.text(`Org-wide incentive total: ${data.orgIncentiveTotalAmount.toFixed(2)}`);
      doc.moveDown();
      doc.fontSize(13).text('Per-Employee Breakdown', { underline: true });
      doc.fontSize(9);
      for (const r of data.rows) {
        doc.text(
          `${r.empCode} — ${r.name} | Todos: ${r.todosApproved}/${r.todosTotal} ` +
            `(${(r.completionRate * 100).toFixed(0)}%) | Incentive: ${r.incentiveTotalAmount.toFixed(2)} ` +
            `(Released: ${r.incentiveReleasedAmount.toFixed(2)})`,
        );
      }

      doc.end();
    });
  }
}
