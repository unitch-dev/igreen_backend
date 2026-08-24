import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export { LeaveType };

/**
 * One entry inside a LeavePolicy bundle's `types` array — maps 1:1 to a
 * LeavePolicyType row. `id` is present when reconciling an existing bundle
 * (update) so the service can match by id first, falling back to matching
 * by `leaveType` when `id` is omitted (e.g. a brand-new type being added to
 * an existing bundle).
 */
export class LeavePolicyTypeItemDto {
  @ApiPropertyOptional({
    description: 'Existing LeavePolicyType UUID (omit when adding a new type)',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ enum: LeaveType, example: LeaveType.CASUAL })
  @IsEnum(LeaveType)
  leaveType: LeaveType;

  @ApiPropertyOptional({ example: 'Casual Leave' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({ description: 'Total leave days entitlement per year', example: 12 })
  @IsNumber()
  @Min(0)
  @Max(365)
  daysPerYear: number;

  @ApiPropertyOptional({
    description: 'Maximum days that can be carried forward to next year. 0 = no carry forward.',
    example: 6,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  carryForwardMax?: number;

  @ApiPropertyOptional({
    description: 'How leave days are accrued over time',
    enum: ['monthly', 'quarterly', 'yearly', 'upfront'],
    example: 'monthly',
  })
  @IsOptional()
  @IsIn(['monthly', 'quarterly', 'yearly', 'upfront'])
  accrualType?: string;

  @ApiPropertyOptional({ description: 'Whether unused leave days can be encashed', example: false })
  @IsOptional()
  @IsBoolean()
  isEncashable?: boolean;

  @ApiPropertyOptional({
    description: 'Whether absence beyond entitlement is marked as Loss of Pay',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isLopEligible?: boolean;

  @ApiPropertyOptional({ description: 'Minimum advance notice required (in days)', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minAdvanceDays?: number;

  @ApiPropertyOptional({
    description: 'Maximum consecutive days allowed per application',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxConsecutiveDays?: number;

  @ApiPropertyOptional({
    description: 'Whether this leave is available during probation period',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  allowedInProbation?: boolean;

  @ApiPropertyOptional({
    description: 'Restrict leave to a specific gender. null/omitted = all genders.',
    enum: ['MALE', 'FEMALE'],
    example: null,
  })
  @IsOptional()
  @IsIn(['MALE', 'FEMALE'])
  genderRestriction?: string;
}
