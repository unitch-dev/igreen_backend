import { ApiProperty } from '@nestjs/swagger';

export class LoanSummaryDto {
  @ApiProperty({ description: 'Count of LoanApplication with status PENDING' })
  pendingCount: number;

  @ApiProperty({
    description: 'Sum of amountRequested for LoanApplication rows with status PENDING (0 if none)',
  })
  pendingAmount: number;

  @ApiProperty({ description: 'Count of LoanApplication with status ACTIVE' })
  activeCount: number;

  @ApiProperty({
    description:
      'Sum of outstanding principal+interest still owed across all ACTIVE loans. Computed the ' +
      'same way as LoansService.getOutstandingBalanceForEmployee — the outstandingBalance of the ' +
      'next undeducted LoanEmiSchedule row per ACTIVE loan (that row already reflects the ' +
      'remaining balance as of that installment), summed across every ACTIVE loan in the org. ' +
      '0 if there are no ACTIVE loans.',
  })
  activeOutstandingAmount: number;
}

export class LeaveSummaryDto {
  @ApiProperty({ description: 'Count of LeaveApplication with status PENDING' })
  pendingCount: number;

  @ApiProperty({
    description:
      'Distinct count of employees with an APPROVED LeaveApplication whose [fromDate, toDate] ' +
      'range includes today (UTC calendar day)',
  })
  onLeaveToday: number;

  @ApiProperty({
    description:
      'Distinct count of employees with an APPROVED LeaveApplication overlapping the current ' +
      'ISO week (Monday 00:00 UTC through Sunday 23:59:59.999 UTC)',
  })
  onLeaveThisWeek: number;
}

export class DashboardLoanLeaveSummaryDto {
  @ApiProperty({ type: LoanSummaryDto })
  loans: LoanSummaryDto;

  @ApiProperty({ type: LeaveSummaryDto })
  leave: LeaveSummaryDto;
}
