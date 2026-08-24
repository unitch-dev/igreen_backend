import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class ApplyLeaveDto {
  @ApiProperty({
    description: 'LeavePolicyType UUID (the specific leave type within the assigned policy bundle)',
  })
  @IsUUID()
  leavePolicyTypeId: string;

  @ApiProperty({ example: '2026-08-01' })
  @IsDateString()
  fromDate: string;

  @ApiProperty({ example: '2026-08-02' })
  @IsDateString()
  toDate: string;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(0.5)
  days: number;

  @ApiPropertyOptional({ example: 'Family function' })
  @IsOptional()
  @IsString()
  reason?: string;
}
