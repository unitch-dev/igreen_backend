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

  @ApiProperty({ nullable: true, description: 'Resolved actor display name, or null if unknown/deleted' })
  actorName: string | null;

  @ApiProperty({ nullable: true, description: 'Resolved actor employee code, or null if unknown/deleted' })
  actorEmpCode: string | null;

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
      'AuditLog entries (CREATE/UPDATE/DELETE/UPSERT) for audited business-entity models ' +
      'in the org/date range, with actor identity resolved. Capped, not paginated.',
  })
  systemChanges: AuditSystemChangeRowDto[];
}
