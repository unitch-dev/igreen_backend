import { Controller, Get, Post, Put, Delete, Body, Param, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RequirePermissions } from '@common/decorators/permissions.decorator';
import {
  ApiCommonErrorResponses,
  ApiSuccessResponse,
} from '@common/swagger/api-responses.decorator';
import { DashboardService } from './dashboard.service';
import { CreateDashboardDto } from './dto/create-dashboard.dto';
import { UpdateDashboardDto } from './dto/update-dashboard.dto';
import { DashboardKpisDto } from './dto/dashboard-kpis.dto';
import { DashboardLoanLeaveSummaryDto } from './dto/dashboard-loan-leave-summary.dto';
import { DashboardAdminAlertsDto } from './dto/dashboard-admin-alerts.dto';

@ApiTags('Dashboards')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('dashboards')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('kpis')
  // Intentionally no @RequirePermissions() here (any authenticated user in the
  // org may call this — auth is still enforced by the global JwtAuthGuard).
  // This single endpoint backs every role's KPI widgets, including
  // kpi_my_leave_balance / kpi_my_performance which are scoped to the
  // caller's own employeeId. Gating it behind 'report:read' 403s for any
  // role that lacks that permission (e.g. `employee`, `dept_manager`,
  // `field_supervisor`, `it_admin`) even though their own dashboard widgets
  // depend on this same call — see docs/known-issues.md 2026-08-22.
  @ApiOperation({
    summary: 'Get aggregated dashboard KPI values',
    description:
      'Returns the KPI widget values (kpi_total_employees, kpi_active_employees, ...) keyed by ' +
      'the same widgetType strings used by the default dashboard configs. No permission gate: ' +
      'every role dashboard calls this for its own KPI tiles, including employee-scoped values.',
  })
  @ApiSuccessResponse(DashboardKpisDto, 'Dashboard KPI values')
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — NOT for a missing permission (this endpoint has no permission requirement). ' +
      'Only occurs for the account-level password-change or onboarding-activation gates that ' +
      'apply to every authenticated route.',
    schema: {
      example: {
        success: false,
        message: 'Password change required',
        error: {
          message: 'Password change required',
          code: 'MUST_CHANGE_PASSWORD',
          statusCode: 403,
          path: '/api/v1/dashboards/kpis',
          method: 'GET',
        },
        errorType: 'HTTP_403',
        httpCode: 403,
      },
    },
  })
  getKpis(@Request() req) {
    const { id, organizationId } = req.user;
    return this.service.getKpis(organizationId, id);
  }

  @Get('loan-leave-summary')
  @RequirePermissions('loan:read', 'leave:read')
  @ApiOperation({
    summary: 'Get org-level loan and leave aggregate summary',
    description:
      'Backs the Admin Dashboard `table_loan_leave_summary` widget. Returns, org-scoped: ' +
      'pending LoanApplication count + total requested amount, ACTIVE LoanApplication count + ' +
      'total outstanding balance (sum of the next undeducted LoanEmiSchedule.outstandingBalance ' +
      "per ACTIVE loan, mirroring LoansService.getOutstandingBalanceForEmployee's modeling); " +
      'and pending LeaveApplication count, distinct employees on APPROVED leave today, and ' +
      'distinct employees on APPROVED leave at any point in the current ISO week ' +
      '(Monday-Sunday, UTC). Requires both loan:read and leave:read (AND logic).',
  })
  @ApiSuccessResponse(DashboardLoanLeaveSummaryDto, 'Loan and leave summary')
  @ApiResponse({
    status: 403,
    description: 'Forbidden — missing required permissions: loan:read, leave:read',
    schema: {
      example: {
        success: false,
        message: 'Missing required permissions: loan:read, leave:read',
        error: {
          message: 'Missing required permissions: loan:read, leave:read',
          statusCode: 403,
          path: '/api/v1/dashboards/loan-leave-summary',
          method: 'GET',
        },
        errorType: 'HTTP_403',
        httpCode: 403,
      },
    },
  })
  getLoanLeaveSummary(@Request() req) {
    return this.service.getLoanLeaveSummary(req.user.organizationId);
  }

  @Get('admin-alerts')
  @RequirePermissions('onboarding:manage')
  @ApiOperation({
    summary: 'Get admin alert aggregates (expiring onboarding links + pending approvals)',
    description:
      'Backs the Admin Dashboard `list_notifications` widget. Returns, org-scoped: the count ' +
      'and top-5-soonest-expiring list of OnboardingLink rows with status PENDING or ' +
      'IN_PROGRESS whose expiresAt falls within the next 7 days, plus the same pending-' +
      "approvals breakdown (leave/loan/serviceRequest/todo) computed by GET /dashboards/kpis's " +
      'kpi_pending_approvals_breakdown. Requires onboarding:manage.',
  })
  @ApiSuccessResponse(DashboardAdminAlertsDto, 'Admin alerts summary')
  @ApiResponse({
    status: 403,
    description: 'Forbidden — missing required permission: onboarding:manage',
    schema: {
      example: {
        success: false,
        message: 'Missing required permissions: onboarding:manage',
        error: {
          message: 'Missing required permissions: onboarding:manage',
          statusCode: 403,
          path: '/api/v1/dashboards/admin-alerts',
          method: 'GET',
        },
        errorType: 'HTTP_403',
        httpCode: 403,
      },
    },
  })
  getAdminAlerts(@Request() req) {
    return this.service.getAdminAlerts(req.user.organizationId);
  }

  @Get()
  @ApiOperation({
    summary: "Get the current user's dashboard",
    description:
      'Returns the dashboard configuration (widgets and layout) assigned to the requesting ' +
      'user, falling back to the role-default dashboard for their org if none is personalized. ' +
      'The JWT payload carries `roles: string[]` (a user may hold multiple roles); the ' +
      'effective role-default is resolved by highest-privilege-wins priority — ' +
      'super_admin > org_admin > hr_manager > finance_manager > dept_manager > it_admin > ' +
      'field_supervisor > employee — falling back to "employee" if none of the held roles ' +
      'match a known dashboard roleName.',
  })
  @ApiSuccessResponse(Object, 'Dashboard configuration for the current user')
  findForUser(@Request() req) {
    const { id, organizationId } = req.user;
    const roleName = this.resolveRoleName(req.user.roles ?? []);
    return this.service.findForUser(id, organizationId, roleName);
  }

  /**
   * Derives the effective dashboard "roleName" for a user who may hold
   * multiple roles, in highest-privilege-wins priority order — matching the
   * exact roleName set defined in DEFAULT_DASHBOARDS (dashboard.service.ts).
   * Falls back to 'employee' if none of the user's roles match a known
   * dashboard roleName.
   */
  private resolveRoleName(userRoles: string[]): string {
    const priority = [
      'super_admin',
      'org_admin',
      'hr_manager',
      'finance_manager',
      'dept_manager',
      'it_admin',
      'field_supervisor',
      'employee',
    ];
    return priority.find((role) => userRoles.includes(role)) ?? 'employee';
  }

  @Get('defaults')
  @ApiOperation({
    summary: 'List default dashboard configurations',
    description: 'Returns the role-default dashboard configurations for the organization.',
  })
  @ApiSuccessResponse(Object, 'Default dashboard configurations', 200)
  findDefaults(@Request() req) {
    return this.service.findDefaults(req.user.organizationId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a dashboard',
    description: 'Creates a custom dashboard (with widgets) for the current user or role.',
  })
  @ApiSuccessResponse(Object, 'Dashboard created', 201)
  create(@Body() dto: CreateDashboardDto, @Request() req) {
    return this.service.create(dto, req.user.id, req.user.organizationId);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update a dashboard',
    description: "Updates an existing dashboard's name, widgets, or default status.",
  })
  @ApiSuccessResponse(Object, 'Dashboard updated')
  update(@Param('id') id: string, @Body() dto: UpdateDashboardDto, @Request() req) {
    return this.service.update(id, dto, req.user.id, req.user.organizationId);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a dashboard',
    description: 'Permanently removes a dashboard configuration.',
  })
  @ApiSuccessResponse(Object, 'Dashboard deleted')
  remove(@Param('id') id: string, @Request() req) {
    return this.service.delete(id, req.user.id, req.user.organizationId);
  }

  @Post('seed-defaults')
  @RequirePermissions('org:update')
  @ApiOperation({
    summary: 'Seed the organization with default dashboards',
    description:
      'Creates the standard role-default dashboard configurations (super_admin, org_admin, ' +
      'hr_manager, employee, etc.) for the organization if they do not already exist. ' +
      'Requires the org:update permission.',
  })
  @ApiSuccessResponse(Object, 'Default dashboards seeded', 201)
  @ApiResponse({
    status: 403,
    description: 'Forbidden — missing required permission: org:update',
    schema: {
      example: {
        statusCode: 403,
        timestamp: '2026-08-18T10:30:00.000Z',
        path: '/api/v1/dashboards/seed-defaults',
        method: 'POST',
        message: 'Missing required permissions: org:update',
      },
    },
  })
  seedDefaults(@Request() req) {
    return this.service.seedDefaults(req.user.organizationId);
  }
}
