import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ServiceRequestCategory, ServiceRequestPriority } from '@prisma/client';

export class CreateServiceRequestDto {
  @ApiProperty({ enum: ServiceRequestCategory })
  @IsEnum(ServiceRequestCategory)
  category: ServiceRequestCategory;

  @ApiProperty({ example: 'Laptop not booting' })
  @IsString()
  @MinLength(3)
  title: string;

  @ApiProperty({ example: 'My laptop stopped booting since yesterday morning.' })
  @IsString()
  @MinLength(3)
  description: string;

  @ApiPropertyOptional({
    enum: ServiceRequestPriority,
    default: ServiceRequestPriority.MEDIUM,
    description:
      'Ignored/escalated for COMPLIANCE category, which is always forced to at least HIGH',
  })
  @IsOptional()
  @IsEnum(ServiceRequestPriority)
  priority?: ServiceRequestPriority;

  @ApiPropertyOptional({
    default: false,
    description:
      'Raise anonymously (requester identity hidden from non-managers). Rejected with 400 if ' +
      'the organization has disabled allowAnonymousServiceRequests. Not permitted for ' +
      'SPECIAL_LEAVE requests (the target employee must always be identified).',
  })
  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;

  @ApiPropertyOptional({
    description:
      "The employee this request is about. Defaults to the caller's own employee record. " +
      "For category=SPECIAL_LEAVE, a manager sets this to one of their direct reports' " +
      'employee id (or any employee, if the caller holds an admin-level permission) — the ' +
      'caller may not file a SPECIAL_LEAVE request for themselves.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  // ─── SPECIAL_LEAVE-only fields ───────────────────────────────────────────
  // Required only when category === SPECIAL_LEAVE (@ValidateIf below); absent
  // for every other category.

  @ApiPropertyOptional({
    description: 'Required when category=SPECIAL_LEAVE. The LeavePolicyType to grant against.',
  })
  @ValidateIf(
    (dto: CreateServiceRequestDto) => dto.category === ServiceRequestCategory.SPECIAL_LEAVE,
  )
  @IsUUID()
  leavePolicyTypeId?: string;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Required when category=SPECIAL_LEAVE.',
  })
  @ValidateIf(
    (dto: CreateServiceRequestDto) => dto.category === ServiceRequestCategory.SPECIAL_LEAVE,
  )
  @IsDateString()
  leaveFromDate?: string;

  @ApiPropertyOptional({
    example: '2026-09-03',
    description: 'Required when category=SPECIAL_LEAVE.',
  })
  @ValidateIf(
    (dto: CreateServiceRequestDto) => dto.category === ServiceRequestCategory.SPECIAL_LEAVE,
  )
  @IsDateString()
  leaveToDate?: string;

  @ApiPropertyOptional({
    example: 3,
    description: 'Required when category=SPECIAL_LEAVE.',
  })
  @ValidateIf(
    (dto: CreateServiceRequestDto) => dto.category === ServiceRequestCategory.SPECIAL_LEAVE,
  )
  @IsNumber()
  @Min(0.5)
  leaveDays?: number;
}
