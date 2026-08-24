import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PayrollRunStatus, LeaveStatus, EmployeeStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LoansService } from '../loans/loans.service';
import { IncentiveLedgerService } from '../incentives/incentive-ledger.service';
import { GreenThanksService } from '../green-thanks/green-thanks.service';
import { paginate } from '@common/dto/pagination.dto';
import { InitiatePayrollRunDto } from './dto/initiate-payroll-run.dto';
import { QueryPayrollRunDto } from './dto/query-payroll-run.dto';
import { QueryPayrollEntryDto } from './dto/query-payroll-entry.dto';
import { UpdatePayrollEntryDto } from './dto/update-payroll-entry.dto';
import {
  computeGross,
  computeLop,
  computePf,
  computeEsi,
  computeNet,
  SalaryComponents,
} from './payroll-calculation';

const EDITABLE_RUN_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.DRAFT,
  PayrollRunStatus.PROCESSING,
  PayrollRunStatus.COMPLETED,
];

@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loansService: LoansService,
    private readonly incentiveLedgerService: IncentiveLedgerService,
    private readonly greenThanksService: GreenThanksService,
  ) {}

  // ─── Runs ───────────────────────────────────────────────────────────────────

  async initiateRun(organizationId: string, userId: string, dto: InitiatePayrollRunDto) {
    const existing = await this.prisma.payrollRun.findUnique({
      where: {
        organizationId_month_year: {
          organizationId,
          month: dto.month,
          year: dto.year,
        },
      },
    });
    if (existing) {
      throw new ConflictException(
        `A payroll run for ${dto.month}/${dto.year} already exists for this organization`,
      );
    }

    const run = await this.prisma.payrollRun.create({
      data: {
        organizationId,
        month: dto.month,
        year: dto.year,
        status: PayrollRunStatus.DRAFT,
        initiatedBy: userId,
      },
    });

    // TODO: move to async queue (BullMQ 'payroll' queue, 'payroll.process' job) —
    // processing inline for now so the API response reflects the final state
    // synchronously without requiring a worker to be online in every environment.
    await this.processRun(organizationId, run.id, dto.employeeIds);

    return this.findOneRun(organizationId, run.id);
  }

  async processRun(organizationId: string, runId: string, employeeIds?: string[]) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId },
    });
    if (!run) throw new NotFoundException('Payroll run not found');

    await this.prisma.payrollRun.update({
      where: { id: runId },
      data: { status: PayrollRunStatus.PROCESSING },
    });

    const employees = await this.prisma.employee.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { not: EmployeeStatus.EXITED },
        ...(employeeIds && employeeIds.length > 0 ? { id: { in: employeeIds } } : {}),
      },
      include: { payrollStructure: true },
    });

    const totalDaysInMonth = this.getTotalDaysInMonth(run.month, run.year);

    for (const employee of employees) {
      // Both the loan (M10) and incentive (M11) accumulate-not-overwrite reads
      // must happen BEFORE computeGross/upsert, since the incentive component
      // feeds into gross and the loan deduction feeds into net. A single
      // existingEntry read is reused for both to avoid fetching it twice.
      const existingEntry = await this.prisma.payrollEntry.findUnique({
        where: {
          payrollRunId_employeeId: { payrollRunId: runId, employeeId: employee.id },
        },
        select: { loanDeduction: true, incentiveAmount: true, greenThanksAmount: true },
      });

      // Incentive released via IncentiveLedgerService (M11). getReleasedIncentiveForPeriod
      // only returns not-yet-deducted rows, so a second processRun pass for the same
      // (month, year) always computes 0 here — that is by design (it prevents
      // re-marking/re-deducting the same ledger row twice). That 0 must never be
      // written over an already-persisted PayrollEntry.incentiveAmount — doing so
      // would silently erase a real incentive on re-run. We therefore accumulate
      // onto whatever is already stored for this entry instead of overwriting it.
      const incentivePeriod = await this.incentiveLedgerService.getReleasedIncentiveForPeriod(
        organizationId,
        employee.id,
        run.month,
        run.year,
      );
      const incentiveAmount =
        (existingEntry?.incentiveAmount ?? 0) + incentivePeriod.totalIncentive;

      // Green Thanks (M12) points convert to INR and flow into gross salary via
      // GreenThanksService. getApprovedGreenThanksForPeriod only returns approved,
      // not-yet-paid rows, so a second processRun pass for the same (month, year)
      // always computes 0 here — that is by design (it prevents re-marking the
      // same GreenThanks row as paid twice). That 0 must never be written over an
      // already-persisted PayrollEntry.greenThanksAmount — doing so would silently
      // erase real points on re-run. We therefore accumulate onto whatever is
      // already stored for this entry instead of overwriting it (see §10 /
      // known-issues.md accumulate-not-overwrite pattern from Loans/Incentives).
      const gtPeriod = await this.greenThanksService.getApprovedGreenThanksForPeriod(
        organizationId,
        employee.id,
        run.month,
        run.year,
      );
      const greenThanksAmount = (existingEntry?.greenThanksAmount ?? 0) + gtPeriod.totalAmount;

      const components = this.resolveComponents(employee);
      components.incentive = incentiveAmount;
      components.greenThanks = greenThanksAmount;
      const grossBreakdown = computeGross(components);

      const lopDays = await this.getLopDaysForEmployee(employee.id, run.month, run.year);
      const lop = computeLop(grossBreakdown.gross, totalDaysInMonth, lopDays);
      const grossMinusLop = grossBreakdown.gross - lop;

      const pf = computePf(grossMinusLop);
      const esi = computeEsi(grossMinusLop);

      // Loan EMI deduction wired via LoansService (M10). getActiveLoanDeductionForPeriod
      // only returns UNDEDUCTED rows, so a second processRun pass for the same
      // (month, year) always computes 0 here — that is by design (it prevents
      // re-marking/re-deducting the same EMI row twice). IMPORTANT: that 0 must
      // never be written over an already-persisted PayrollEntry.loanDeduction —
      // doing so would silently erase a real deduction on re-run. We therefore
      // accumulate onto whatever is already stored for this entry instead of
      // overwriting it outright (see known-issues.md 2026-07-11 [loans/payroll]).
      const loanPeriodDeduction = await this.loansService.getActiveLoanDeductionForPeriod(
        organizationId,
        employee.id,
        run.month,
        run.year,
      );
      const loanDeduction = (existingEntry?.loanDeduction ?? 0) + loanPeriodDeduction.totalEmi;
      // TODO(M11+ advances): advance deductions are a separate future feature; stays 0 until implemented.
      const advanceDeduction = 0;
      const tds = 0;
      const otherDeductions = 0;
      const professionalTax = 0;

      const netSalary = computeNet({
        gross: grossBreakdown.gross,
        pf,
        esi,
        lop,
        tds,
        loanDeduction,
        advanceDeduction,
        otherDeductions,
      });

      const presentDays = Math.max(0, totalDaysInMonth - lopDays);

      const entry = await this.prisma.payrollEntry.upsert({
        where: {
          payrollRunId_employeeId: {
            payrollRunId: runId,
            employeeId: employee.id,
          },
        },
        create: {
          payrollRunId: runId,
          employeeId: employee.id,
          workingDays: totalDaysInMonth,
          presentDays,
          lopDays,
          basicSalary: grossBreakdown.basic,
          hra: grossBreakdown.hra,
          specialAllowance: grossBreakdown.specialAllowance,
          educationAllowance: grossBreakdown.educationAllowance,
          otherAllowances: grossBreakdown.otherAllowances,
          incentiveAmount: grossBreakdown.incentive,
          cumulativeIncentive: grossBreakdown.cumulativeIncentive,
          overtimeAmount: grossBreakdown.overtime,
          travelAllowance: grossBreakdown.travelAllowance,
          bonus: grossBreakdown.bonus,
          greenThanksAmount: grossBreakdown.greenThanks,
          grossSalary: grossBreakdown.gross,
          pfEmployee: pf,
          pfEmployer: pf,
          esiEmployee: esi,
          esiEmployer: esi,
          professionalTax,
          tds,
          loanDeduction,
          advanceDeduction,
          otherDeductions,
          netSalary,
        },
        update: {
          workingDays: totalDaysInMonth,
          presentDays,
          lopDays,
          basicSalary: grossBreakdown.basic,
          hra: grossBreakdown.hra,
          specialAllowance: grossBreakdown.specialAllowance,
          educationAllowance: grossBreakdown.educationAllowance,
          otherAllowances: grossBreakdown.otherAllowances,
          incentiveAmount: grossBreakdown.incentive,
          cumulativeIncentive: grossBreakdown.cumulativeIncentive,
          overtimeAmount: grossBreakdown.overtime,
          travelAllowance: grossBreakdown.travelAllowance,
          bonus: grossBreakdown.bonus,
          greenThanksAmount: grossBreakdown.greenThanks,
          grossSalary: grossBreakdown.gross,
          pfEmployee: pf,
          pfEmployer: pf,
          esiEmployee: esi,
          esiEmployer: esi,
          professionalTax,
          loanDeduction,
          netSalary,
        },
      });

      await this.loansService.markEmiDeducted(loanPeriodDeduction.scheduleIds, entry.id);
      await this.incentiveLedgerService.markIncentiveDeducted(incentivePeriod.ledgerIds, entry.id);
      await this.greenThanksService.markGreenThanksPaid(gtPeriod.greenThanksIds, entry.id);
    }

    return this.prisma.payrollRun.update({
      where: { id: runId },
      data: { status: PayrollRunStatus.COMPLETED, processedAt: new Date() },
    });
  }

  async findAllRuns(organizationId: string, query: QueryPayrollRunDto) {
    const where: Prisma.PayrollRunWhereInput = {
      organizationId,
      ...(query.status && { status: query.status }),
      ...(query.month && { month: query.month }),
      ...(query.year && { year: query.year }),
    };

    const [runs, total] = await Promise.all([
      this.prisma.payrollRun.findMany({
        where,
        include: { entries: { select: { grossSalary: true, netSalary: true } } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.payrollRun.count({ where }),
    ]);

    return paginate(
      runs.map((run) => this.toRunSummary(run)),
      total,
      query,
    );
  }

  async findOneRun(organizationId: string, runId: string) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId },
      include: { entries: { select: { grossSalary: true, netSalary: true } } },
    });
    if (!run) throw new NotFoundException('Payroll run not found');
    return this.toRunSummary(run);
  }

  async approveRun(organizationId: string, userId: string, runId: string) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId },
    });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status !== PayrollRunStatus.COMPLETED) {
      throw new BadRequestException('Only a COMPLETED payroll run can be approved');
    }

    await this.prisma.payrollRun.update({
      where: { id: runId },
      data: { status: PayrollRunStatus.APPROVED, approvedAt: new Date() },
    });

    return this.findOneRun(organizationId, runId);
  }

  async disburseRun(organizationId: string, userId: string, runId: string) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId },
    });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status !== PayrollRunStatus.APPROVED) {
      throw new BadRequestException('Only an APPROVED payroll run can be disbursed');
    }

    await this.prisma.payrollRun.update({
      where: { id: runId },
      data: { status: PayrollRunStatus.DISBURSED, disbursedAt: new Date() },
    });

    return this.findOneRun(organizationId, runId);
  }

  // ─── Entries ────────────────────────────────────────────────────────────────

  async listEntries(organizationId: string, runId: string, query: QueryPayrollEntryDto) {
    await this.assertRunInOrg(organizationId, runId);

    const where: Prisma.PayrollEntryWhereInput = {
      payrollRunId: runId,
      employee: {
        ...(query.departmentId && { departmentId: query.departmentId }),
        ...(query.search && {
          OR: [
            { firstName: { contains: query.search } },
            { lastName: { contains: query.search } },
            { empCode: { contains: query.search } },
          ],
        }),
      },
    };

    const [entries, total] = await Promise.all([
      this.prisma.payrollEntry.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              empCode: true,
              firstName: true,
              lastName: true,
              department: { select: { name: true } },
            },
          },
        },
        orderBy: { employee: { empCode: 'asc' } },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.payrollEntry.count({ where }),
    ]);

    return paginate(
      entries.map((entry) => this.toEntryResponse(entry)),
      total,
      query,
    );
  }

  async getEntry(organizationId: string, runId: string, employeeId: string) {
    await this.assertRunInOrg(organizationId, runId);

    const entry = await this.prisma.payrollEntry.findFirst({
      where: { payrollRunId: runId, employeeId },
      include: {
        employee: {
          select: {
            id: true,
            empCode: true,
            firstName: true,
            lastName: true,
            department: { select: { name: true } },
          },
        },
      },
    });
    if (!entry) throw new NotFoundException('Payroll entry not found for this employee');
    return this.toEntryResponse(entry);
  }

  async updateEntry(
    organizationId: string,
    runId: string,
    employeeId: string,
    dto: UpdatePayrollEntryDto,
  ) {
    const run = await this.assertRunInOrg(organizationId, runId);
    if (!EDITABLE_RUN_STATUSES.includes(run.status)) {
      throw new BadRequestException(
        'Payroll entries cannot be edited once the run has been approved',
      );
    }

    const entry = await this.prisma.payrollEntry.findFirst({
      where: { payrollRunId: runId, employeeId },
    });
    if (!entry) throw new NotFoundException('Payroll entry not found for this employee');

    const tds = dto.tds ?? entry.tds;
    const otherDeductions = dto.otherDeductions ?? entry.otherDeductions;

    const netSalary = computeNet({
      gross: entry.grossSalary,
      pf: entry.pfEmployee,
      esi: entry.esiEmployee,
      lop: (entry.grossSalary / this.getTotalDaysInMonth(run.month, run.year)) * entry.lopDays,
      tds,
      loanDeduction: entry.loanDeduction,
      advanceDeduction: entry.advanceDeduction,
      otherDeductions,
    });

    await this.prisma.payrollEntry.update({
      where: { id: entry.id },
      data: {
        remarks: dto.remarks ?? entry.remarks,
        tds,
        otherDeductions,
        netSalary,
      },
    });

    return this.getEntry(organizationId, runId, employeeId);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async assertRunInOrg(organizationId: string, runId: string) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id: runId, organizationId },
    });
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  getTotalDaysInMonth(month: number, year: number): number {
    return new Date(year, month, 0).getDate();
  }

  async getLopDaysForEmployee(employeeId: string, month: number, year: number): Promise<number> {
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

    const applications = await this.prisma.leaveApplication.findMany({
      where: {
        employeeId,
        status: LeaveStatus.APPROVED,
        leavePolicyType: { isLopEligible: true },
        fromDate: { lte: monthEnd },
        toDate: { gte: monthStart },
      },
      select: { days: true },
    });

    // Secondary source (AttendanceLog ABSENT days without an approved leave)
    // is intentionally not summed here yet — leave-application data is the
    // primary LOP source per the plan; attendance-based LOP can double-count
    // days already covered by an approved LOP-eligible leave application.
    return applications.reduce((sum, application) => sum + application.days, 0);
  }

  resolveComponents(employee: {
    payrollStructure: { components: Prisma.JsonValue } | null;
  }): SalaryComponents {
    const raw = (employee.payrollStructure?.components ?? {}) as Record<string, unknown>;
    const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0);

    return {
      basic: asNumber(raw.basic),
      hra: asNumber(raw.hra),
      specialAllowance: asNumber(raw.specialAllowance),
      educationAllowance: asNumber(raw.educationAllowance),
      travelAllowance: asNumber(raw.travelAllowance),
      otherAllowances: asNumber(raw.otherAllowances),
      // Incentive/Bonus/GreenThanks/CumulativeIncentive/Overtime default 0 —
      // resolved from IncentiveLedger/AttendanceLog/GreenThanks once those
      // modules (M11/M12) exist and are wired into payroll processing.
      incentive: 0,
      cumulativeIncentive: 0,
      overtime: 0,
      bonus: 0,
      greenThanks: 0,
    };
  }

  private toRunSummary(run: {
    id: string;
    organizationId: string;
    month: number;
    year: number;
    status: PayrollRunStatus;
    initiatedBy: string | null;
    processedAt: Date | null;
    approvedAt: Date | null;
    disbursedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    entries: { grossSalary: number; netSalary: number }[];
  }) {
    const totalGross = run.entries.reduce((sum, entry) => sum + entry.grossSalary, 0);
    const totalNet = run.entries.reduce((sum, entry) => sum + entry.netSalary, 0);

    return {
      id: run.id,
      organizationId: run.organizationId,
      month: run.month,
      year: run.year,
      status: run.status,
      initiatedBy: run.initiatedBy,
      processedAt: run.processedAt,
      approvedAt: run.approvedAt,
      disbursedAt: run.disbursedAt,
      entryCount: run.entries.length,
      totalGross,
      totalNet,
      totalDeductions: totalGross - totalNet,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private toEntryResponse(entry: {
    id: string;
    payrollRunId: string;
    employeeId: string;
    employee: {
      id: string;
      empCode: string;
      firstName: string;
      lastName: string;
      department: { name: string } | null;
    };
    workingDays: number;
    presentDays: number;
    lopDays: number;
    basicSalary: number;
    hra: number;
    specialAllowance: number;
    educationAllowance: number;
    otherAllowances: number;
    incentiveAmount: number;
    cumulativeIncentive: number;
    overtimeAmount: number;
    travelAllowance: number;
    bonus: number;
    greenThanksAmount: number;
    grossSalary: number;
    pfEmployee: number;
    esiEmployee: number;
    professionalTax: number;
    tds: number;
    loanDeduction: number;
    advanceDeduction: number;
    otherDeductions: number;
    netSalary: number;
    remarks: string | null;
    status: string;
  }) {
    return {
      id: entry.id,
      payrollRunId: entry.payrollRunId,
      employeeId: entry.employeeId,
      employee: {
        id: entry.employee.id,
        empCode: entry.employee.empCode,
        firstName: entry.employee.firstName,
        lastName: entry.employee.lastName,
        departmentName: entry.employee.department?.name ?? null,
      },
      workingDays: entry.workingDays,
      presentDays: entry.presentDays,
      lopDays: entry.lopDays,
      basicSalary: entry.basicSalary,
      hra: entry.hra,
      specialAllowance: entry.specialAllowance,
      educationAllowance: entry.educationAllowance,
      otherAllowances: entry.otherAllowances,
      incentiveAmount: entry.incentiveAmount,
      cumulativeIncentive: entry.cumulativeIncentive,
      overtimeAmount: entry.overtimeAmount,
      travelAllowance: entry.travelAllowance,
      bonus: entry.bonus,
      greenThanksAmount: entry.greenThanksAmount,
      grossSalary: entry.grossSalary,
      pfEmployee: entry.pfEmployee,
      esiEmployee: entry.esiEmployee,
      professionalTax: entry.professionalTax,
      tds: entry.tds,
      loanDeduction: entry.loanDeduction,
      advanceDeduction: entry.advanceDeduction,
      otherDeductions: entry.otherDeductions,
      netSalary: entry.netSalary,
      remarks: entry.remarks,
      status: entry.status,
    };
  }

  // TODO: GET /payroll/runs/:id/export — bank disbursement Excel export (exceljs)
  // TODO: GET /payroll/runs/:id/entries/:employeeId/payslip — payslip PDF (PDFKit) + file storage
}
