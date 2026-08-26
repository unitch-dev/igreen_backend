import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class ApproveTodoDto {
  @ApiProperty({ example: true, description: 'true = approve, false = reject' })
  @IsBoolean()
  approve: boolean;

  @ApiPropertyOptional({
    description:
      'IncentiveRule UUID to attach at approval time, for a todo that was created without one. ' +
      'Required to approve if the todo still has no linked rule.',
  })
  @IsOptional()
  @IsUUID()
  incentiveRuleId?: string;

  @ApiPropertyOptional({ example: 'Quantity does not match delivery logs' })
  @IsOptional()
  @IsString()
  rejectionNote?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Hold the incentive amount instead of releasing it immediately',
  })
  @IsOptional()
  @IsBoolean()
  hold?: boolean;

  @ApiPropertyOptional({ example: 7, minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  payrollMonth?: number;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @IsInt()
  payrollYear?: number;
}
