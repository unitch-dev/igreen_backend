import {
  Body,
  Controller,
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
import {
  ApiCommonErrorResponses,
  ApiPaginatedResponse,
  ApiSuccessResponse,
} from '@common/swagger/api-responses.decorator';
import { PayrollService } from './payroll.service';
import { InitiatePayrollRunDto } from './dto/initiate-payroll-run.dto';
import { QueryPayrollRunDto } from './dto/query-payroll-run.dto';
import { QueryPayrollEntryDto } from './dto/query-payroll-entry.dto';
import { UpdatePayrollEntryDto } from './dto/update-payroll-entry.dto';
import { PayrollRunResponseDto } from './dto/payroll-run-response.dto';
import { PayrollEntryResponseDto } from './dto/payroll-entry-response.dto';

@ApiTags('Payroll')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payrollService: PayrollService) {}

  @Post('runs')
  @RequirePermissions('payroll:run')
  @ApiOperation({
    summary: 'Initiate a payroll run for a month/year and compute all entries',
    description:
      'Creates a DRAFT PayrollRun, synchronously computes a PayrollEntry for every active ' +
      'employee (or the optional employeeIds subset), and returns the run in COMPLETED state ' +
      'with aggregate totals. Fails with 409 if a run already exists for the given month/year.',
  })
  @ApiSuccessResponse(PayrollRunResponseDto, 'Payroll run initiated and computed', 201)
  initiateRun(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: InitiatePayrollRunDto,
  ) {
    return this.payrollService.initiateRun(organizationId, userId, dto);
  }

  @Get('runs')
  @RequirePermissions('payroll:read')
  @ApiOperation({
    summary: 'List payroll runs (paginated)',
    description: 'Filter by ?status=&month=&year=. Ordered by year/month descending.',
  })
  @ApiPaginatedResponse(PayrollRunResponseDto, 'Paginated list of payroll runs')
  findAllRuns(@OrganizationId() organizationId: string, @Query() query: QueryPayrollRunDto) {
    return this.payrollService.findAllRuns(organizationId, query);
  }

  @Get('runs/:id')
  @RequirePermissions('payroll:read')
  @ApiOperation({ summary: 'Get a payroll run detail with summary totals' })
  @ApiParam({ name: 'id', description: 'PayrollRun UUID' })
  @ApiSuccessResponse(PayrollRunResponseDto, 'Payroll run detail')
  findOneRun(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.payrollService.findOneRun(organizationId, id);
  }

  @Put('runs/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll:approve')
  @ApiOperation({
    summary: 'Approve a COMPLETED payroll run',
    description: 'Transitions a run from COMPLETED to APPROVED. Returns 400 for any other status.',
  })
  @ApiParam({ name: 'id', description: 'PayrollRun UUID' })
  @ApiSuccessResponse(PayrollRunResponseDto, 'Payroll run approved')
  approveRun(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.payrollService.approveRun(organizationId, userId, id);
  }

  @Put('runs/:id/disburse')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll:approve')
  @ApiOperation({
    summary: 'Mark an APPROVED payroll run as DISBURSED',
    description: 'Transitions a run from APPROVED to DISBURSED. Returns 400 for any other status.',
  })
  @ApiParam({ name: 'id', description: 'PayrollRun UUID' })
  @ApiSuccessResponse(PayrollRunResponseDto, 'Payroll run disbursed')
  disburseRun(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.payrollService.disburseRun(organizationId, userId, id);
  }

  @Get('runs/:id/entries')
  @RequirePermissions('payroll:read')
  @ApiOperation({
    summary: 'List per-employee payroll entries for a run (paginated)',
    description: 'Filter by ?departmentId=&search= (employee name or empCode).',
  })
  @ApiParam({ name: 'id', description: 'PayrollRun UUID' })
  @ApiPaginatedResponse(PayrollEntryResponseDto, 'Paginated list of payroll entries')
  listEntries(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Query() query: QueryPayrollEntryDto,
  ) {
    return this.payrollService.listEntries(organizationId, id, query);
  }

  @Get('runs/:id/entries/:employeeId')
  @RequirePermissions('payroll:read')
  @ApiOperation({ summary: 'Get a single employee payslip-shaped entry for a run' })
  @ApiParam({ name: 'id', description: 'PayrollRun UUID' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiSuccessResponse(PayrollEntryResponseDto, 'Payroll entry detail')
  getEntry(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
  ) {
    return this.payrollService.getEntry(organizationId, id, employeeId);
  }

  @Put('runs/:id/entries/:employeeId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll:run')
  @ApiOperation({
    summary: 'Edit remarks/tds/otherDeductions on a payroll entry and recompute net',
    description:
      'Only permitted while the parent run is DRAFT, PROCESSING, or COMPLETED. Returns 400 once ' +
      'the run has been APPROVED or DISBURSED.',
  })
  @ApiParam({ name: 'id', description: 'PayrollRun UUID' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiSuccessResponse(PayrollEntryResponseDto, 'Payroll entry updated and net salary recomputed')
  updateEntry(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
    @Body() dto: UpdatePayrollEntryDto,
  ) {
    return this.payrollService.updateEntry(organizationId, id, employeeId, dto);
  }

  // TODO: GET /payroll/runs/:id/export — bank disbursement Excel export (exceljs)
  // TODO: GET /payroll/runs/:id/entries/:employeeId/payslip — payslip PDF (PDFKit) + file storage
}
