import { ApiProperty } from '@nestjs/swagger';

export class PerformanceReportRowDto {
  @ApiProperty()
  employeeId: string;

  @ApiProperty()
  empCode: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  cycleId: string;

  @ApiProperty()
  cycleName: string;

  @ApiProperty()
  rating: number;

  @ApiProperty()
  isEligibleForIncrement: boolean;

  @ApiProperty()
  ratedBy: string;

  @ApiProperty()
  submittedAt: string;

  @ApiProperty()
  kpiAssignedCount: number;

  @ApiProperty()
  kpiAchievedCount: number;

  @ApiProperty({ description: '0-1, 0 when no KPIs are assigned' })
  kpiAchievementRate: number;
}

export class PerformanceReportDto {
  @ApiProperty({ description: 'Period start date (ISO)' })
  from: string;

  @ApiProperty({ description: 'Period end date (ISO)' })
  to: string;

  @ApiProperty({ description: 'Average rating across all matched PerformanceRating rows' })
  avgRating: number;

  @ApiProperty({ description: 'Count of all matched PerformanceRating rows' })
  totalRatingsCount: number;

  @ApiProperty({ type: [PerformanceReportRowDto], description: 'Paginated per-employee rows' })
  rows: PerformanceReportRowDto[];

  @ApiProperty()
  meta: { total: number; page: number; limit: number; totalPages: number };
}
