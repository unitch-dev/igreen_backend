import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { OrganizationId } from '@common/decorators/organization.decorator';
import { RequirePermissions } from '@common/decorators/permissions.decorator';
import {
  ApiCommonErrorResponses,
  ApiSuccessResponse,
} from '@common/swagger/api-responses.decorator';
import { ReportsService, REPORT_TYPES, ReportType } from './reports.service';
import { QueryReportDto } from './dto/query-report.dto';
import { ExportReportDto } from './dto/export-report.dto';
import { HeadcountReportDto } from './dto/headcount-report.dto';
import { AttendanceReportDto } from './dto/attendance-report.dto';
import { LeaveReportDto } from './dto/leave-report.dto';
import { PayrollReportDto } from './dto/payroll-report.dto';
import { LoanReportDto } from './dto/loan-report.dto';
import { IncentiveReportDto } from './dto/incentive-report.dto';
import { AttendanceTrackReportDto } from './dto/attendance-track-report.dto';
import { PerformanceReportDto } from './dto/performance-report.dto';
import { TodoIncentiveReportDto } from './dto/todo-incentive-report.dto';
import { AuditHistoryReportDto } from './dto/audit-history-report.dto';

@ApiTags('Reports')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('headcount')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Headcount report',
    description:
      'Total employee count plus breakdowns by department, designation, employment type, and status.',
  })
  @ApiSuccessResponse(HeadcountReportDto, 'Headcount report')
  headcount(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.headcount(organizationId, query);
  }

  @Get('attendance')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Attendance report',
    description:
      'Present/absent counts and loss-of-pay days for the given period, org-wide and per employee.',
  })
  @ApiSuccessResponse(AttendanceReportDto, 'Attendance report')
  attendance(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.attendance(organizationId, query);
  }

  @Get('leave')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Leave report',
    description: 'Per-employee leave entitlement/taken/balance plus count of pending applications.',
  })
  @ApiSuccessResponse(LeaveReportDto, 'Leave report')
  leave(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.leave(organizationId, query);
  }

  @Get('payroll')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Payroll report',
    description: 'Totals and component-wise breakdown for a payroll run (defaults to the latest).',
  })
  @ApiSuccessResponse(PayrollReportDto, 'Payroll report')
  payroll(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.payroll(organizationId, query);
  }

  @Get('loans')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Loans report',
    description: 'Active loan count, total outstanding balance, and per-loan rows.',
  })
  @ApiSuccessResponse(LoanReportDto, 'Loans report')
  loans(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.loans(organizationId, query);
  }

  @Get('incentives')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Incentives report',
    description: 'Per-employee/per-month sum of incentive ledger amounts.',
  })
  @ApiSuccessResponse(IncentiveReportDto, 'Incentives report')
  incentives(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.incentives(organizationId, query);
  }

  @Get('attendance-track')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Attendance & live track report',
    description:
      'Paginated attendance log rows (with check-in/out geolocation) plus a snapshot of the ' +
      'latest live location per employee recorded within the last 30 minutes.',
  })
  @ApiSuccessResponse(AttendanceTrackReportDto, 'Attendance & live track report')
  attendanceTrack(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.attendanceTrack(organizationId, query);
  }

  @Get('performance')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Performance report',
    description:
      'Per-employee performance ratings for the period plus KPI assignment/achievement stats.',
  })
  @ApiSuccessResponse(PerformanceReportDto, 'Performance report')
  performance(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.performance(organizationId, query);
  }

  @Get('todo-incentive')
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: 'Todo & incentive report',
    description: 'Per-employee todo completion stats correlated with incentive ledger payouts.',
  })
  @ApiSuccessResponse(TodoIncentiveReportDto, 'Todo & incentive report')
  todoIncentive(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.todoIncentive(organizationId, query);
  }

  @Get('audit')
  @RequirePermissions('report:audit')
  @ApiOperation({
    summary: 'Audit — login & system-change history',
    description:
      'Per-user login history (with device/IP info) plus a best-effort AuditLog system-change ' +
      'feed. Security-sensitive — gated by the dedicated report:audit permission, not report:read.',
  })
  @ApiSuccessResponse(AuditHistoryReportDto, 'Audit history report')
  auditHistory(@OrganizationId() organizationId: string, @Query() query: QueryReportDto) {
    return this.reportsService.auditHistory(organizationId, query);
  }

  @Get(':type/export')
  @RequirePermissions('report:export')
  @ApiOperation({
    summary: 'Export a report as Excel or PDF',
    description:
      'Streams a binary file (bypasses the response envelope). Excel is supported for all ' +
      'report types; PDF is implemented for payroll, attendance-track, performance, and ' +
      'todo-incentive. Exporting type=audit additionally requires the report:audit permission.',
  })
  @ApiParam({ name: 'type', enum: REPORT_TYPES })
  async exportReport(
    @OrganizationId() organizationId: string,
    @Param('type') type: string,
    @Query() query: ExportReportDto,
    @CurrentUser('permissions') callerPermissions: string[],
    @Res() res: Response,
  ) {
    if (!REPORT_TYPES.includes(type as ReportType)) {
      throw new BadRequestException(
        `Unknown report type '${type}'. Expected one of: ${REPORT_TYPES.join(', ')}`,
      );
    }

    const hasAuditPermission =
      callerPermissions?.includes('*') || callerPermissions?.includes('report:audit');
    if (type === 'audit' && !hasAuditPermission) {
      throw new ForbiddenException('Missing required permission: report:audit');
    }

    const { buffer, filename, contentType } = await this.reportsService.export(
      organizationId,
      type,
      query.format,
      query,
    );

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}
