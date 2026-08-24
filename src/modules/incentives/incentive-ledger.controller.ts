import { Body, Controller, Get, HttpCode, HttpStatus, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { OrganizationId } from '@common/decorators/organization.decorator';
import { RequirePermissions } from '@common/decorators/permissions.decorator';
import {
  ApiCommonErrorResponses,
  ApiPaginatedResponse,
  ApiSuccessResponse,
} from '@common/swagger/api-responses.decorator';
import { IncentiveLedgerService } from './incentive-ledger.service';
import { RequestingUser } from './todos.service';
import { QueryIncentiveLedgerDto } from './dto/query-incentive-ledger.dto';
import { ReleaseIncentiveDto } from './dto/release-incentive.dto';
import { IncentiveLedgerResponseDto } from './dto/incentive-ledger-response.dto';

@ApiTags('Incentives')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('incentive-ledger')
export class IncentiveLedgerController {
  constructor(private readonly incentiveLedgerService: IncentiveLedgerService) {}

  @Get()
  @RequirePermissions('incentive:read')
  @ApiOperation({
    summary: 'List incentive ledger entries (paginated)',
    description:
      'Users without payroll:read/todo:approve see only their own ledger entries; approvers see ' +
      'all entries in the organization, optionally filtered by ?employeeId=&isHeld=&isReleased=&payrollMonth=&payrollYear=.',
  })
  @ApiPaginatedResponse(IncentiveLedgerResponseDto, 'Paginated list of incentive ledger entries')
  findAll(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Query() query: QueryIncentiveLedgerDto,
  ) {
    return this.incentiveLedgerService.findAll(organizationId, currentUser, query);
  }

  @Put(':id/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('incentive:manage')
  @ApiOperation({ summary: 'Release a held incentive for payroll inclusion' })
  @ApiParam({ name: 'id', description: 'IncentiveLedger UUID' })
  @ApiSuccessResponse(IncentiveLedgerResponseDto, 'Incentive ledger entry released')
  release(
    @OrganizationId() organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('employeeId') approverEmployeeId: string,
    @Param('id') id: string,
    @Body() dto: ReleaseIncentiveDto,
  ) {
    return this.incentiveLedgerService.release(organizationId, userId, approverEmployeeId, id, dto);
  }
}
