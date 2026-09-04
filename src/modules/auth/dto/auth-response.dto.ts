import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EmployeeSummaryDto {
  @ApiProperty({ example: 'emp_uuid_123' })
  id: string;

  @ApiProperty({ example: 'G S1084' })
  empCode: string;

  @ApiProperty({ example: 'Saravanan' })
  firstName: string;

  @ApiProperty({ example: 'G S' })
  lastName: string;

  @ApiProperty({ example: 'Finance' })
  department: string;

  @ApiProperty({ example: 'Finance Head' })
  designation: string;
}

export class AutoLogoutConfigDto {
  @ApiProperty({
    example: false,
    description: 'Whether this organization has a daily auto-logout cutoff configured.',
  })
  enabled: boolean;

  @ApiPropertyOptional({
    example: '21:30',
    nullable: true,
    description:
      'Wall-clock cutoff in 24h "HH:mm" format, evaluated in `timezone`. Null when unset.',
  })
  time: string | null;

  @ApiProperty({
    example: 'Asia/Kolkata',
    description: 'IANA timezone the cutoff is evaluated in.',
  })
  timezone: string;
}

export class AuthUserDto {
  @ApiProperty({ example: 'user_uuid_123' })
  id: string;

  @ApiProperty({ example: 'finance@igreentec.in' })
  email: string;

  @ApiProperty({ example: '9876543210', nullable: true })
  phone: string | null;

  @ApiProperty({ example: 'org_uuid_456' })
  organizationId: string;

  @ApiPropertyOptional({
    example: 'IGreen Technologies',
    nullable: true,
    description: 'Current organization name — used for tenant branding in the frontend shell.',
  })
  organizationName: string | null;

  @ApiPropertyOptional({
    example: 'http://localhost:3001/uploads/organizations/org_uuid_456/logo.png',
    nullable: true,
    description:
      'Current organization logo URL — used for tenant branding in the frontend shell/login page.',
  })
  organizationLogoUrl: string | null;

  @ApiProperty({
    type: AutoLogoutConfigDto,
    description:
      'Per-organization auto-logout cutoff. Surfaced here (not just on GET /organization) ' +
      'because roles without org:read (e.g. employee) must still be able to enforce it client-side.',
  })
  autoLogout: AutoLogoutConfigDto;

  @ApiProperty({
    example: false,
    description:
      'When true, every non-exempt route 403s with MUST_CHANGE_PASSWORD until the user calls ' +
      'PUT /auth/change-password — the frontend MUST redirect to the forced change-password ' +
      'screen whenever this is true.',
  })
  mustChangePassword: boolean;

  @ApiProperty({
    example: ['employee:read', 'payroll:view', 'leave:apply'],
    type: [String],
  })
  permissions: string[];

  @ApiProperty({
    example: [{ id: 'role_uuid_789', name: 'hr_manager' }],
    description: 'All roles assigned to this user (used by the frontend Profile page).',
  })
  roles: Array<{ id: string; name: string }>;

  @ApiProperty({ type: EmployeeSummaryDto, nullable: true })
  employee: EmployeeSummaryDto | null;
}

export class AuthResponseDto {
  @ApiProperty({
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyX3V1aWQiLCJlbWFpbCI6ImZpbmFuY2VAaWdyZWVudGVjLmluIiwiaWF0IjoxNzEwMDAwMDAwLCJleHAiOjE3MTAwMDA5MDB9.signature',
    description: 'JWT access token — valid for 15 minutes',
  })
  accessToken: string;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh_payload.signature',
    description: 'Refresh token — valid for 30 days; store securely',
  })
  refreshToken: string;

  @ApiProperty({ example: '15m', description: 'Access token validity duration' })
  expiresIn: string;

  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;
}

export class OtpSentResponseDto {
  @ApiProperty({ example: true })
  sent: boolean;

  @ApiProperty({ example: 'OTP sent successfully to +91 98765 43210' })
  message: string;

  @ApiProperty({ example: 300, description: 'OTP validity in seconds' })
  validForSeconds: number;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'Logged out successfully' })
  message: string;
}

export class DeviceTokenResponseDto {
  @ApiProperty({ example: true })
  registered: boolean;

  @ApiProperty({ example: 'Device token registered for push notifications' })
  message: string;
}
