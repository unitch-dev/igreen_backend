import { ApiProperty } from '@nestjs/swagger';

export class AuditLoginRowDto {
  @ApiProperty()
  userId: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ nullable: true })
  empCode: string | null;

  @ApiProperty()
  name: string;

  @ApiProperty({ nullable: true })
  ipAddress: string | null;

  @ApiProperty({ nullable: true })
  userAgent: string | null;

  @ApiProperty({ nullable: true })
  deviceInfo: string | null;

  @ApiProperty()
  loginAt: string;

  @ApiProperty({ nullable: true })
  logoutAt: string | null;

  @ApiProperty()
  status: string;
}

export class AuditSystemChangeRowDto {
  @ApiProperty()
  action: string;

  @ApiProperty()
  entityType: string;

  @ApiProperty({ nullable: true })
  entityId: string | null;

  @ApiProperty({ nullable: true })
  actorId: string | null;

  @ApiProperty()
  occurredAt: string;

  @ApiProperty({ nullable: true })
  ipAddress: string | null;
}

export class AuditHistoryReportDto {
  @ApiProperty({ description: 'Period start date (ISO)' })
  from: string;

  @ApiProperty({ description: 'Period end date (ISO)' })
  to: string;

  @ApiProperty({ description: 'Count of all matched login attempts' })
  totalLogins: number;

  @ApiProperty({ description: "Count of matched login attempts with status !== 'success'" })
  failedLogins: number;

  @ApiProperty({ description: 'Distinct userId count across matched login attempts' })
  uniqueUsers: number;

  @ApiProperty({ type: [AuditLoginRowDto], description: 'Paginated login history rows' })
  rows: AuditLoginRowDto[];

  @ApiProperty()
  meta: { total: number; page: number; limit: number; totalPages: number };

  @ApiProperty({
    type: [AuditSystemChangeRowDto],
    description:
      'Best-effort AuditLog entries for the org/date range (capped, not paginated). ' +
      'Likely empty — nothing in the codebase currently writes to AuditLog.',
  })
  systemChanges: AuditSystemChangeRowDto[];
}
