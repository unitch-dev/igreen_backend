import { ApiProperty } from '@nestjs/swagger';
import { OnboardingStatus } from '@prisma/client';

export class ExpiringOnboardingLinkDto {
  @ApiProperty({ description: 'OnboardingLink id' })
  id: string;

  @ApiProperty({ nullable: true, description: 'Candidate name, if captured' })
  candidateName: string | null;

  @ApiProperty({ description: 'Candidate email the link was issued to' })
  email: string;

  @ApiProperty({ description: 'When the link expires' })
  expiresAt: Date;

  @ApiProperty({ enum: OnboardingStatus, description: 'Current onboarding status of the link' })
  status: OnboardingStatus;
}

export class OnboardingLinksExpiringSoonDto {
  @ApiProperty({
    description:
      'Count of OnboardingLink rows with status PENDING or IN_PROGRESS whose expiresAt falls ' +
      'within the next 7 days (inclusive of now)',
  })
  count: number;

  @ApiProperty({
    type: [ExpiringOnboardingLinkDto],
    description: 'Top 5 soonest-expiring links, ordered by expiresAt ascending',
  })
  items: ExpiringOnboardingLinkDto[];
}

export class AdminAlertsPendingApprovalsDto {
  @ApiProperty({ description: 'PENDING LeaveApplication count' })
  leave: number;

  @ApiProperty({ description: 'PENDING LoanApplication count' })
  loan: number;

  @ApiProperty({ description: 'OPEN ServiceRequest count' })
  serviceRequest: number;

  @ApiProperty({ description: 'SUBMITTED TodoTask count (awaiting manager review)' })
  todo: number;
}

export class DashboardAdminAlertsDto {
  @ApiProperty({ type: OnboardingLinksExpiringSoonDto })
  onboardingLinksExpiringSoon: OnboardingLinksExpiringSoonDto;

  @ApiProperty({ type: AdminAlertsPendingApprovalsDto })
  pendingApprovals: AdminAlertsPendingApprovalsDto;
}
