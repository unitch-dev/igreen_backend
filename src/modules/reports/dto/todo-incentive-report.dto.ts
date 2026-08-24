import { ApiProperty } from '@nestjs/swagger';

export class TodoIncentiveReportRowDto {
  @ApiProperty()
  employeeId: string;

  @ApiProperty()
  empCode: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  todosTotal: number;

  @ApiProperty()
  todosApproved: number;

  @ApiProperty()
  todosRejected: number;

  @ApiProperty({ description: 'todosApproved / todosTotal, 0 when todosTotal is 0' })
  completionRate: number;

  @ApiProperty({ description: 'Sum of IncentiveLedger.totalAmount for this employee in range' })
  incentiveTotalAmount: number;

  @ApiProperty({ description: 'Sum of IncentiveLedger.releaseAmount for this employee in range' })
  incentiveReleasedAmount: number;
}

export class TodoIncentiveReportDto {
  @ApiProperty({ description: 'Count of APPROVED todos org-wide (within filters)' })
  orgTodosApproved: number;

  @ApiProperty({ description: 'Sum of IncentiveLedger.totalAmount org-wide (within filters)' })
  orgIncentiveTotalAmount: number;

  @ApiProperty({ type: [TodoIncentiveReportRowDto], description: 'Paginated per-employee rows' })
  rows: TodoIncentiveReportRowDto[];

  @ApiProperty()
  meta: { total: number; page: number; limit: number; totalPages: number };
}
