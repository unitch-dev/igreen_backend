import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { OrganizationId } from '@common/decorators/organization.decorator';
import { RequirePermissions } from '@common/decorators/permissions.decorator';
import { QueryHolidaysDto } from './dto/query-holidays.dto';
import { QueryLeaveBalanceDto } from './dto/query-leave-balance.dto';
import { LeavePoliciesService } from './leave-policies.service';
import { LeaveBalanceService } from './leave-balance.service';
import { LeaveApplicationsService } from './leave-applications.service';
import { HolidaysService } from './holidays.service';
import { GlobalLeaveService } from './global-leave.service';
import { CreateLeavePolicyDto } from './dto/create-leave-policy.dto';
import { UpdateLeavePolicyDto } from './dto/update-leave-policy.dto';
import { QueryLeavePolicyDto } from './dto/query-leave-policy.dto';
import { ApplyLeaveDto } from './dto/apply-leave.dto';
import { QueryLeaveDto } from './dto/query-leave.dto';
import { ApproveLeaveDto, RejectLeaveDto } from './dto/decide-leave.dto';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { GlobalLeaveItemDto } from './dto/global-leave-item.dto';
import { BulkCreateGlobalLeaveDto } from './dto/bulk-create-global-leave.dto';
import { QueryGlobalLeaveDto } from './dto/query-global-leave.dto';

@ApiTags('Leave')
@ApiBearerAuth()
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly leavePoliciesService: LeavePoliciesService,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly leaveApplicationsService: LeaveApplicationsService,
    private readonly holidaysService: HolidaysService,
    private readonly globalLeaveService: GlobalLeaveService,
  ) {}

  // ─── Leave Policies ───────────────────────────────────────────────────────

  @Get('policies')
  @RequirePermissions('leave:read')
  @ApiOperation({ summary: 'List leave policies' })
  findAllPolicies(@OrganizationId() organizationId: string, @Query() query: QueryLeavePolicyDto) {
    return this.leavePoliciesService.findAll(organizationId, query);
  }

  @Post('policies')
  @RequirePermissions('org:update')
  @ApiOperation({ summary: 'Create a leave policy' })
  createPolicy(@OrganizationId() organizationId: string, @Body() dto: CreateLeavePolicyDto) {
    return this.leavePoliciesService.create(organizationId, dto);
  }

  @Put('policies/:id')
  @RequirePermissions('org:update')
  @ApiOperation({ summary: 'Update a leave policy' })
  @ApiParam({ name: 'id', description: 'Leave policy UUID' })
  updatePolicy(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Body() dto: UpdateLeavePolicyDto,
  ) {
    return this.leavePoliciesService.update(organizationId, id, dto);
  }

  @Put('policies/:id/toggle')
  @RequirePermissions('org:update')
  @ApiOperation({ summary: 'Toggle a leave policy active/inactive' })
  @ApiParam({ name: 'id', description: 'Leave policy UUID' })
  togglePolicy(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.leavePoliciesService.toggle(organizationId, id);
  }

  // ─── Balances ─────────────────────────────────────────────────────────────

  @Get('balances')
  @RequirePermissions('leave:read')
  @ApiOperation({ summary: 'List leave balances (HR view, paginated)' })
  getBalances(@OrganizationId() organizationId: string, @Query() query: QueryLeaveBalanceDto) {
    return this.leaveBalanceService.getBalances(organizationId, query);
  }

  @Get('my-balance')
  @RequirePermissions('leave:apply')
  @ApiOperation({ summary: 'Get my own leave balances for the current year' })
  getMyBalance(
    @OrganizationId() organizationId: string,
    @CurrentUser('employeeId') employeeId: string,
  ) {
    return this.leaveBalanceService.getMyBalance(organizationId, employeeId);
  }

  // ─── Applications ─────────────────────────────────────────────────────────

  @Get('my')
  @RequirePermissions('leave:apply')
  @ApiOperation({ summary: 'List my own leave applications' })
  myApplications(
    @OrganizationId() organizationId: string,
    @CurrentUser('employeeId') employeeId: string,
    @Query() query: QueryLeaveDto,
  ) {
    return this.leaveApplicationsService.myApplications(organizationId, employeeId, query);
  }

  @Post('apply')
  @RequirePermissions('leave:apply')
  @ApiOperation({ summary: 'Apply for leave' })
  apply(
    @OrganizationId() organizationId: string,
    @CurrentUser('employeeId') employeeId: string,
    @Body() dto: ApplyLeaveDto,
  ) {
    return this.leaveApplicationsService.apply(organizationId, employeeId, dto);
  }

  @Get()
  @RequirePermissions('leave:read')
  @ApiOperation({ summary: 'List leave applications (HR/manager view, paginated)' })
  findAll(@OrganizationId() organizationId: string, @Query() query: QueryLeaveDto) {
    return this.leaveApplicationsService.findAll(organizationId, query);
  }

  @Put(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leave:apply')
  @ApiOperation({ summary: 'Cancel my own pending leave application' })
  @ApiParam({ name: 'id', description: 'LeaveApplication UUID' })
  cancel(
    @OrganizationId() organizationId: string,
    @CurrentUser('employeeId') employeeId: string,
    @Param('id') id: string,
  ) {
    return this.leaveApplicationsService.cancel(organizationId, employeeId, id);
  }

  @Put(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leave:approve')
  @ApiOperation({ summary: 'Approve a pending leave application' })
  @ApiParam({ name: 'id', description: 'LeaveApplication UUID' })
  approve(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('employeeId') approverEmployeeId: string,
    @Param('id') id: string,
    @Body() dto: ApproveLeaveDto,
  ) {
    return this.leaveApplicationsService.approve(
      organizationId,
      id,
      userId,
      approverEmployeeId,
      dto,
    );
  }

  @Put(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('leave:approve')
  @ApiOperation({ summary: 'Reject a pending leave application' })
  @ApiParam({ name: 'id', description: 'LeaveApplication UUID' })
  reject(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('employeeId') approverEmployeeId: string,
    @Param('id') id: string,
    @Body() dto: RejectLeaveDto,
  ) {
    return this.leaveApplicationsService.reject(
      organizationId,
      id,
      userId,
      approverEmployeeId,
      dto,
    );
  }

  // ─── Holidays ─────────────────────────────────────────────────────────────

  @Get('holidays')
  @RequirePermissions('leave:read')
  @ApiOperation({ summary: 'List organization holidays' })
  findAllHolidays(@OrganizationId() organizationId: string, @Query() query: QueryHolidaysDto) {
    return this.holidaysService.findAll(organizationId, query);
  }

  @Post('holidays')
  @RequirePermissions('org:update')
  @ApiOperation({ summary: 'Create a holiday' })
  createHoliday(@OrganizationId() organizationId: string, @Body() dto: CreateHolidayDto) {
    return this.holidaysService.create(organizationId, dto);
  }

  @Put('holidays/:id')
  @RequirePermissions('org:update')
  @ApiOperation({ summary: 'Update a holiday' })
  @ApiParam({ name: 'id', description: 'Holiday UUID' })
  updateHoliday(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Body() dto: UpdateHolidayDto,
  ) {
    return this.holidaysService.update(organizationId, id, dto);
  }

  @Delete('holidays/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('org:update')
  @ApiOperation({ summary: 'Delete a holiday' })
  @ApiParam({ name: 'id', description: 'Holiday UUID' })
  deleteHoliday(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.holidaysService.delete(organizationId, id);
  }

  // ─── Global Leave ─────────────────────────────────────────────────────────

  @Get('global-leaves/my')
  @RequirePermissions('leave:read')
  @ApiOperation({
    summary: "Get global leaves visible on the current employee's calendar",
    description:
      'Returns global leaves where appliesToAll=true, plus any zone-tagged entries matching ' +
      "the employee's assigned Zone, for the given year (defaults to current year).",
  })
  getMyGlobalLeaves(
    @OrganizationId() organizationId: string,
    @CurrentUser('employeeId') employeeId: string | null,
    @Query('year') year?: string,
  ) {
    const resolvedYear = year ? parseInt(year, 10) : new Date().getFullYear();
    return this.globalLeaveService.getForEmployee(organizationId, employeeId, resolvedYear);
  }

  @Get('global-leaves')
  @RequirePermissions('leave:read')
  @ApiOperation({ summary: 'List global leaves (paginated), optionally filtered by year' })
  findAllGlobalLeaves(
    @OrganizationId() organizationId: string,
    @Query() query: QueryGlobalLeaveDto,
  ) {
    return this.globalLeaveService.findAll(organizationId, query);
  }

  @Post('global-leaves')
  @RequirePermissions('org:update')
  @ApiOperation({ summary: 'Create a single global leave' })
  createGlobalLeave(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: GlobalLeaveItemDto,
  ) {
    return this.globalLeaveService.create(organizationId, userId, dto);
  }

  @Post('global-leaves/bulk')
  @RequirePermissions('org:update')
  @ApiOperation({
    summary: 'Bulk-create global leaves',
    description:
      'Creates multiple global leaves in one transaction. Rows with unknown zone ids are ' +
      'reported per-row in `errors` rather than failing the whole batch.',
  })
  bulkCreateGlobalLeaves(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: BulkCreateGlobalLeaveDto,
  ) {
    return this.globalLeaveService.bulkCreate(organizationId, userId, dto);
  }

  @Delete('global-leaves/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('org:update')
  @ApiOperation({ summary: 'Delete a global leave' })
  @ApiParam({ name: 'id', description: 'GlobalLeave UUID' })
  deleteGlobalLeave(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.globalLeaveService.delete(organizationId, id);
  }
}
