import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import {
  AttendanceStatus,
  EmployeeStatus,
  LeaveStatus,
  LoanStatus,
  OnboardingStatus,
  ServiceRequestStatus,
  TodoStatus,
} from '@prisma/client';
import { PrismaService } from '@prisma/prisma.service';
import { CreateDashboardDto } from './dto/create-dashboard.dto';
import { UpdateDashboardDto } from './dto/update-dashboard.dto';
import { DashboardKpisDto } from './dto/dashboard-kpis.dto';
import { DashboardLoanLeaveSummaryDto } from './dto/dashboard-loan-leave-summary.dto';
import { DashboardAdminAlertsDto } from './dto/dashboard-admin-alerts.dto';

export interface DefaultWidget {
  widgetType: string;
  title: string;
  position: number;
  colSpan: number;
}

export interface DefaultDashboard {
  name: string;
  roleName: string;
  widgets: DefaultWidget[];
}

export const DEFAULT_DASHBOARDS: DefaultDashboard[] = [
  {
    name: 'Admin Dashboard',
    roleName: 'org_admin',
    widgets: [
      { widgetType: 'kpi_total_employees', title: 'Total Employees', position: 0, colSpan: 1 },
      { widgetType: 'kpi_pending_approvals', title: 'Pending Approvals', position: 1, colSpan: 1 },
      { widgetType: 'map_live_tracking', title: 'Live Tracking', position: 2, colSpan: 2 },
      {
        widgetType: 'table_loan_leave_summary',
        title: 'Loan & Leave Summaries',
        position: 3,
        colSpan: 2,
      },
      {
        widgetType: 'list_notifications',
        title: 'Notifications & Reminders',
        position: 4,
        colSpan: 2,
      },
    ],
  },
  {
    name: 'Super Admin Dashboard',
    roleName: 'super_admin',
    widgets: [
      { widgetType: 'kpi_total_employees', title: 'Total Employees', position: 0, colSpan: 1 },
      { widgetType: 'kpi_active_employees', title: 'Active Employees', position: 1, colSpan: 1 },
      { widgetType: 'kpi_attendance_rate', title: 'Attendance Rate', position: 2, colSpan: 1 },
      { widgetType: 'kpi_pending_approvals', title: 'Pending Approvals', position: 3, colSpan: 1 },
      { widgetType: 'chart_employee_status', title: 'Employee Status', position: 4, colSpan: 2 },
      {
        widgetType: 'chart_department_headcount',
        title: 'Dept Headcount',
        position: 5,
        colSpan: 2,
      },
      { widgetType: 'table_recent_joiners', title: 'Recent Joiners', position: 6, colSpan: 2 },
      { widgetType: 'activity_recent', title: 'Recent Activity', position: 7, colSpan: 2 },
    ],
  },
  {
    name: 'HR Manager Dashboard',
    roleName: 'hr_manager',
    widgets: [
      { widgetType: 'kpi_total_employees', title: 'Total Employees', position: 0, colSpan: 1 },
      { widgetType: 'kpi_active_employees', title: 'Active Employees', position: 1, colSpan: 1 },
      { widgetType: 'kpi_attendance_rate', title: 'Attendance Rate', position: 2, colSpan: 1 },
      { widgetType: 'kpi_pending_approvals', title: 'Pending Approvals', position: 3, colSpan: 1 },
      { widgetType: 'chart_employee_status', title: 'Employee Status', position: 4, colSpan: 2 },
      {
        widgetType: 'chart_department_headcount',
        title: 'Dept Headcount',
        position: 5,
        colSpan: 2,
      },
      { widgetType: 'table_recent_joiners', title: 'Recent Joiners', position: 6, colSpan: 2 },
      { widgetType: 'activity_recent', title: 'Recent Activity', position: 7, colSpan: 2 },
    ],
  },
  {
    name: 'Finance Manager Dashboard',
    roleName: 'finance_manager',
    widgets: [
      { widgetType: 'kpi_payroll_total', title: 'Payroll Total', position: 0, colSpan: 2 },
      { widgetType: 'kpi_open_loans', title: 'Open Loans', position: 1, colSpan: 1 },
      { widgetType: 'kpi_pending_approvals', title: 'Pending Approvals', position: 2, colSpan: 1 },
      { widgetType: 'chart_payroll_trend', title: 'Payroll Trend', position: 3, colSpan: 4 },
      { widgetType: 'table_pending_loans', title: 'Pending Loans', position: 4, colSpan: 4 },
    ],
  },
  {
    name: 'Department Manager Dashboard',
    roleName: 'dept_manager',
    widgets: [
      { widgetType: 'kpi_active_employees', title: 'Active Employees', position: 0, colSpan: 1 },
      { widgetType: 'kpi_on_leave', title: 'On Leave', position: 1, colSpan: 1 },
      { widgetType: 'kpi_attendance_rate', title: 'Attendance Rate', position: 2, colSpan: 1 },
      { widgetType: 'kpi_pending_approvals', title: 'Pending Approvals', position: 3, colSpan: 1 },
      { widgetType: 'chart_attendance_bar', title: 'Attendance', position: 4, colSpan: 2 },
      { widgetType: 'table_pending_leaves', title: 'Pending Leaves', position: 5, colSpan: 2 },
      { widgetType: 'table_late_arrivals', title: 'Late Arrivals', position: 6, colSpan: 4 },
    ],
  },
  {
    name: 'Field Supervisor Dashboard',
    roleName: 'field_supervisor',
    widgets: [
      { widgetType: 'kpi_active_employees', title: 'Active Employees', position: 0, colSpan: 1 },
      { widgetType: 'kpi_attendance_rate', title: 'Attendance Rate', position: 1, colSpan: 1 },
      { widgetType: 'chart_attendance_bar', title: 'Attendance', position: 2, colSpan: 2 },
      { widgetType: 'table_late_arrivals', title: 'Late Arrivals', position: 3, colSpan: 4 },
    ],
  },
  {
    name: 'Employee Dashboard',
    roleName: 'employee',
    widgets: [
      { widgetType: 'clock_checkin', title: 'Attendance Status', position: 0, colSpan: 2 },
      { widgetType: 'kpi_my_leave_balance', title: 'Leave Balance', position: 1, colSpan: 1 },
      { widgetType: 'list_my_todos', title: 'Todo List', position: 2, colSpan: 2 },
      { widgetType: 'widget_green_thanks', title: 'Green Thanks', position: 3, colSpan: 1 },
      { widgetType: 'list_notices', title: 'Notices', position: 4, colSpan: 2 },
    ],
  },
  {
    name: 'IT Admin Dashboard',
    roleName: 'it_admin',
    widgets: [
      { widgetType: 'kpi_open_assets', title: 'Open Assets', position: 0, colSpan: 1 },
      { widgetType: 'kpi_open_tickets', title: 'Open Tickets', position: 1, colSpan: 1 },
      { widgetType: 'kpi_total_employees', title: 'Total Employees', position: 2, colSpan: 1 },
      { widgetType: 'kpi_active_employees', title: 'Active Employees', position: 3, colSpan: 1 },
      { widgetType: 'table_pending_loans', title: 'Pending Loans', position: 4, colSpan: 4 },
    ],
  },
];

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async findForUser(userId: string, organizationId: string, roleName: string) {
    return this.prisma.dashboardConfig.findMany({
      where: {
        organizationId,
        OR: [{ userId }, { isDefault: true, roleName }],
      },
      include: {
        widgets: { orderBy: { position: 'asc' } },
      },
    });
  }

  async findDefaults(organizationId: string) {
    return this.prisma.dashboardConfig.findMany({
      where: { organizationId, isDefault: true },
      include: { widgets: { orderBy: { position: 'asc' } } },
    });
  }

  async create(dto: CreateDashboardDto, userId: string, organizationId: string) {
    return this.prisma.dashboardConfig.create({
      data: {
        organizationId,
        userId,
        name: dto.name,
        isDefault: dto.isDefault ?? false,
        roleName: dto.roleName,
        widgets: dto.widgets
          ? {
              create: dto.widgets.map((w) => ({
                widgetType: w.widgetType,
                title: w.title,
                position: w.position,
                colSpan: w.colSpan ?? 1,
                rowSpan: w.rowSpan ?? 1,
                config: w.config ?? {},
              })),
            }
          : undefined,
      },
      include: { widgets: { orderBy: { position: 'asc' } } },
    });
  }

  async update(id: string, dto: UpdateDashboardDto, userId: string, organizationId: string) {
    const dashboard = await this.prisma.dashboardConfig.findUnique({ where: { id } });
    if (!dashboard) throw new NotFoundException(`Dashboard ${id} not found`);
    if (dashboard.organizationId !== organizationId) throw new ForbiddenException();
    if (dashboard.userId && dashboard.userId !== userId) throw new ForbiddenException();

    // Delete old widgets and recreate
    if (dto.widgets) {
      await this.prisma.dashboardWidget.deleteMany({ where: { dashboardId: id } });
    }

    return this.prisma.dashboardConfig.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.widgets && {
          widgets: {
            create: dto.widgets.map((w) => ({
              widgetType: w.widgetType,
              title: w.title,
              position: w.position,
              colSpan: w.colSpan ?? 1,
              rowSpan: w.rowSpan ?? 1,
              config: w.config ?? {},
            })),
          },
        }),
      },
      include: { widgets: { orderBy: { position: 'asc' } } },
    });
  }

  async delete(id: string, userId: string, organizationId: string) {
    const dashboard = await this.prisma.dashboardConfig.findUnique({ where: { id } });
    if (!dashboard) throw new NotFoundException(`Dashboard ${id} not found`);
    if (dashboard.organizationId !== organizationId) throw new ForbiddenException();
    if (dashboard.userId && dashboard.userId !== userId) throw new ForbiddenException();

    await this.prisma.dashboardConfig.delete({ where: { id } });
    return { message: 'Dashboard deleted' };
  }

  async seedDefaults(organizationId: string) {
    const results: any[] = [];

    for (const def of DEFAULT_DASHBOARDS) {
      const existing = await this.prisma.dashboardConfig.findFirst({
        where: { organizationId, roleName: def.roleName, isDefault: true },
        include: { widgets: { orderBy: { position: 'asc' } } },
      });

      if (existing) {
        const matches = this.widgetsMatchDefinition(existing.widgets, def.widgets);

        if (matches && existing.name === def.name) {
          results.push({ roleName: def.roleName, status: 'unchanged', id: existing.id });
          continue;
        }

        await this.prisma.dashboardWidget.deleteMany({ where: { dashboardId: existing.id } });
        await this.prisma.dashboardConfig.update({
          where: { id: existing.id },
          data: {
            name: def.name,
            widgets: {
              create: def.widgets.map((w) => ({
                widgetType: w.widgetType,
                title: w.title,
                position: w.position,
                colSpan: w.colSpan,
              })),
            },
          },
        });

        results.push({ roleName: def.roleName, status: 'reconciled', id: existing.id });
        continue;
      }

      const created = await this.prisma.dashboardConfig.create({
        data: {
          organizationId,
          name: def.name,
          roleName: def.roleName,
          isDefault: true,
          widgets: {
            create: def.widgets.map((w) => ({
              widgetType: w.widgetType,
              title: w.title,
              position: w.position,
              colSpan: w.colSpan,
            })),
          },
        },
      });

      results.push({ roleName: def.roleName, status: 'created', id: created.id });
    }

    return results;
  }

  /**
   * Compares persisted widgets against a DEFAULT_DASHBOARDS definition on the
   * tuple (widgetType, title, position, colSpan), in order. Used by
   * seedDefaults() to idempotently reconcile role-default dashboards whenever
   * DEFAULT_DASHBOARDS changes in code — running seedDefaults() twice in a
   * row against an unchanged definition must yield 'unchanged' both times.
   */
  private widgetsMatchDefinition(
    existingWidgets: { widgetType: string; title: string; position: number; colSpan: number }[],
    defWidgets: DefaultWidget[],
  ): boolean {
    if (existingWidgets.length !== defWidgets.length) return false;

    return existingWidgets.every((w, i) => {
      const def = defWidgets[i];
      return (
        w.widgetType === def.widgetType &&
        w.title === def.title &&
        w.position === def.position &&
        w.colSpan === def.colSpan
      );
    });
  }

  // ─── KPIs (M17) ─────────────────────────────────────────────────────────────

  /**
   * Aggregates the KPI widget values consumed by the frontend WidgetRenderer.
   * Keys match the `widgetType` strings used in DEFAULT_DASHBOARDS above exactly.
   */
  async getKpis(organizationId: string, userId: string): Promise<DashboardKpisDto> {
    const employeeFilter = { organizationId, deletedAt: null };

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [
      totalEmployees,
      activeEmployees,
      onLeaveEmployees,
      presentLogs,
      countedLogs,
      pendingLeave,
      pendingLoan,
      openServiceRequests,
      pendingTodos,
      latestPayrollRun,
      openLoans,
      openAssets,
      openTickets,
      user,
    ] = await Promise.all([
      this.prisma.employee.count({ where: employeeFilter }),
      this.prisma.employee.count({ where: { ...employeeFilter, status: EmployeeStatus.ACTIVE } }),
      this.prisma.employee.count({
        where: { ...employeeFilter, status: EmployeeStatus.ON_LEAVE },
      }),
      this.prisma.attendanceLog.count({
        where: {
          employee: employeeFilter,
          date: { gte: monthStart, lte: now },
          status: AttendanceStatus.PRESENT,
        },
      }),
      this.prisma.attendanceLog.count({
        where: {
          employee: employeeFilter,
          date: { gte: monthStart, lte: now },
          status: { notIn: [AttendanceStatus.HOLIDAY, AttendanceStatus.WEEK_OFF] },
        },
      }),
      this.prisma.leaveApplication.count({
        where: { status: LeaveStatus.PENDING, employee: employeeFilter },
      }),
      this.prisma.loanApplication.count({
        where: { status: LoanStatus.PENDING, employee: employeeFilter },
      }),
      this.prisma.serviceRequest.count({
        where: { organizationId, status: ServiceRequestStatus.OPEN },
      }),
      this.prisma.todoTask.count({
        where: { status: TodoStatus.SUBMITTED, employee: employeeFilter },
      }),
      this.prisma.payrollRun.findFirst({
        where: { organizationId },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        select: { id: true },
      }),
      this.prisma.loanApplication.count({
        where: { status: LoanStatus.ACTIVE, employee: employeeFilter },
      }),
      this.prisma.assetAssignment.count({
        where: { returnedAt: null, employee: employeeFilter },
      }),
      this.prisma.serviceRequest.count({
        where: { organizationId, status: ServiceRequestStatus.OPEN },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { employeeId: true } }),
    ]);

    const payrollTotal = latestPayrollRun
      ? ((
          await this.prisma.payrollEntry.aggregate({
            where: { payrollRunId: latestPayrollRun.id },
            _sum: { netSalary: true },
          })
        )._sum.netSalary ?? 0)
      : null;

    const employeeId = user?.employeeId ?? null;

    let myLeaveBalance: number | null = null;
    let myPerformance: number | null = null;

    if (employeeId) {
      const year = now.getUTCFullYear();
      const [balanceAgg, latestRating] = await Promise.all([
        this.prisma.leaveBalance.aggregate({
          where: { employeeId, year },
          _sum: { balanceDays: true },
        }),
        this.prisma.performanceRating.findFirst({
          where: { employeeId },
          orderBy: { submittedAt: 'desc' },
          select: { rating: true },
        }),
      ]);
      myLeaveBalance = balanceAgg._sum.balanceDays ?? 0;
      myPerformance = latestRating?.rating ?? null;
    }

    const pendingApprovalsBreakdown = {
      leave: pendingLeave,
      loan: pendingLoan,
      serviceRequest: openServiceRequests,
      todo: pendingTodos,
    };

    return {
      kpi_total_employees: totalEmployees,
      kpi_active_employees: activeEmployees,
      kpi_on_leave: onLeaveEmployees,
      kpi_attendance_rate: countedLogs > 0 ? Math.round((presentLogs / countedLogs) * 100) : null,
      kpi_pending_approvals: pendingLeave + pendingLoan + openServiceRequests + pendingTodos,
      kpi_pending_approvals_breakdown: pendingApprovalsBreakdown,
      kpi_payroll_total: payrollTotal,
      kpi_open_loans: openLoans,
      kpi_open_assets: openAssets,
      kpi_open_tickets: openTickets,
      kpi_my_leave_balance: myLeaveBalance,
      kpi_my_performance: myPerformance,
    };
  }

  // ─── Admin Dashboard: table_loan_leave_summary / list_notifications widgets ──

  /**
   * Aggregates the data backing the Admin Dashboard's `table_loan_leave_summary`
   * widget. Org-scoped (via `employee: { organizationId, deletedAt: null }`,
   * matching getKpis()'s convention).
   */
  async getLoanLeaveSummary(organizationId: string): Promise<DashboardLoanLeaveSummaryDto> {
    const employeeFilter = { organizationId, deletedAt: null };
    const now = new Date();
    const todayStart = startOfDayUtc(now);
    const todayEnd = endOfDayUtc(now);
    const weekStart = startOfWeekUtc(now);
    const weekEnd = endOfWeekUtc(now);

    const [
      pendingLoanAgg,
      activeLoanCount,
      activeLoans,
      pendingLeaveCount,
      onLeaveTodayRows,
      onLeaveThisWeekRows,
    ] = await Promise.all([
      this.prisma.loanApplication.aggregate({
        where: { status: LoanStatus.PENDING, employee: employeeFilter },
        _count: { _all: true },
        _sum: { amountRequested: true },
      }),
      this.prisma.loanApplication.count({
        where: { status: LoanStatus.ACTIVE, employee: employeeFilter },
      }),
      this.prisma.loanApplication.findMany({
        where: { status: LoanStatus.ACTIVE, employee: employeeFilter },
        select: { id: true },
      }),
      this.prisma.leaveApplication.count({
        where: { status: LeaveStatus.PENDING, employee: employeeFilter },
      }),
      this.prisma.leaveApplication.findMany({
        where: {
          status: LeaveStatus.APPROVED,
          employee: employeeFilter,
          fromDate: { lte: todayEnd },
          toDate: { gte: todayStart },
        },
        select: { employeeId: true },
        distinct: ['employeeId'],
      }),
      this.prisma.leaveApplication.findMany({
        where: {
          status: LeaveStatus.APPROVED,
          employee: employeeFilter,
          fromDate: { lte: weekEnd },
          toDate: { gte: weekStart },
        },
        select: { employeeId: true },
        distinct: ['employeeId'],
      }),
    ]);

    // Same modeling as LoansService.getOutstandingBalanceForEmployee: sum the
    // outstandingBalance of the next undeducted EMI row per ACTIVE loan.
    let activeOutstandingAmount = 0;
    for (const loan of activeLoans) {
      const nextInstallment = await this.prisma.loanEmiSchedule.findFirst({
        where: { loanId: loan.id, isDeducted: false },
        orderBy: [{ emiYear: 'asc' }, { emiMonth: 'asc' }],
        select: { outstandingBalance: true },
      });
      if (nextInstallment) activeOutstandingAmount += nextInstallment.outstandingBalance;
    }

    return {
      loans: {
        pendingCount: pendingLoanAgg._count._all,
        pendingAmount: pendingLoanAgg._sum.amountRequested ?? 0,
        activeCount: activeLoanCount,
        activeOutstandingAmount,
      },
      leave: {
        pendingCount: pendingLeaveCount,
        onLeaveToday: onLeaveTodayRows.length,
        onLeaveThisWeek: onLeaveThisWeekRows.length,
      },
    };
  }

  /**
   * Aggregates the data backing the Admin Dashboard's `list_notifications`
   * widget: onboarding links expiring within the next 7 days, plus the same
   * pending-approvals breakdown getKpis() computes (duplicated here
   * intentionally per this module's convention — see rule in module plan —
   * getKpis()'s existing behavior/return shape must not change).
   */
  async getAdminAlerts(organizationId: string): Promise<DashboardAdminAlertsDto> {
    const now = new Date();
    const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const expiringLinksWhere = {
      organizationId,
      status: { in: [OnboardingStatus.PENDING, OnboardingStatus.IN_PROGRESS] },
      expiresAt: { gte: now, lte: sevenDaysOut },
    };

    const [
      expiringLinksCount,
      expiringLinks,
      pendingLeave,
      pendingLoan,
      openServiceRequests,
      pendingTodos,
    ] = await Promise.all([
      this.prisma.onboardingLink.count({ where: expiringLinksWhere }),
      this.prisma.onboardingLink.findMany({
        where: expiringLinksWhere,
        orderBy: { expiresAt: 'asc' },
        take: 5,
        select: { id: true, candidateName: true, email: true, expiresAt: true, status: true },
      }),
      this.prisma.leaveApplication.count({
        where: { status: LeaveStatus.PENDING, employee: { organizationId, deletedAt: null } },
      }),
      this.prisma.loanApplication.count({
        where: { status: LoanStatus.PENDING, employee: { organizationId, deletedAt: null } },
      }),
      this.prisma.serviceRequest.count({
        where: { organizationId, status: ServiceRequestStatus.OPEN },
      }),
      this.prisma.todoTask.count({
        where: { status: TodoStatus.SUBMITTED, employee: { organizationId, deletedAt: null } },
      }),
    ]);

    return {
      onboardingLinksExpiringSoon: {
        count: expiringLinksCount,
        items: expiringLinks,
      },
      pendingApprovals: {
        leave: pendingLeave,
        loan: pendingLoan,
        serviceRequest: openServiceRequests,
        todo: pendingTodos,
      },
    };
  }
}

// ─── Date helpers (UTC-anchored — see backend/CLAUDE.md rule on @db.Date /
// same-day lookups: local-midnight helpers silently break in positive-UTC-
// offset timezones, so every boundary here is built via Date.UTC) ────────────

function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfDayUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999),
  );
}

/** Monday 00:00:00.000 UTC of the ISO week containing `date`. */
function startOfWeekUtc(date: Date): Date {
  const start = startOfDayUtc(date);
  const day = start.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  start.setUTCDate(start.getUTCDate() + diffToMonday);
  return start;
}

/** Sunday 23:59:59.999 UTC of the ISO week containing `date`. */
function endOfWeekUtc(date: Date): Date {
  const start = startOfWeekUtc(date);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}
