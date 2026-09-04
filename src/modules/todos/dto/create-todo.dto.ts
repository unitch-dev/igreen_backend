import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateTodoDto {
  @ApiProperty({ example: 'Deliver 20 parcels in Sector 5' })
  @IsString()
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'IncentiveRule UUID this todo is linked to' })
  @IsOptional()
  @IsUUID()
  incentiveRuleId?: string;

  @ApiPropertyOptional({ example: 20, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ example: 'parcels' })
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional({ example: '2026-07-20' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional({
    description:
      'Employee UUID to create the todo on behalf of (requires todo:approve). Defaults to the caller’s own employee record.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}
