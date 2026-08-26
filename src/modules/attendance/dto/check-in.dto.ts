import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceSource } from '@prisma/client';
import { IsEnum, IsISO8601, IsNumber, IsOptional } from 'class-validator';

export class CheckInDto {
  @ApiPropertyOptional({ example: 19.076, description: 'Defaults to 0 when GPS is unavailable' })
  @IsOptional()
  @IsNumber()
  lat?: number;

  @ApiPropertyOptional({ example: 72.8777, description: 'Defaults to 0 when GPS is unavailable' })
  @IsOptional()
  @IsNumber()
  lng?: number;

  @ApiPropertyOptional({ example: 12.5, description: 'GPS accuracy in meters' })
  @IsOptional()
  @IsNumber()
  accuracy?: number;

  @ApiPropertyOptional({ enum: AttendanceSource, default: AttendanceSource.MOBILE })
  @IsOptional()
  @IsEnum(AttendanceSource)
  source?: AttendanceSource;

  @ApiPropertyOptional({ description: 'ISO timestamp override; defaults to server time' })
  @IsOptional()
  @IsISO8601()
  timestamp?: string;
}

export class LiveLocationDto {
  @ApiProperty({ example: 19.076 })
  @IsNumber()
  lat: number;

  @ApiProperty({ example: 72.8777 })
  @IsNumber()
  lng: number;

  @ApiPropertyOptional({ example: 12.5 })
  @IsOptional()
  @IsNumber()
  accuracy?: number;
}
