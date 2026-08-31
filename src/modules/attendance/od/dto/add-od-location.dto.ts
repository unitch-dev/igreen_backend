import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Min } from 'class-validator';

export class AddOdLocationDto {
  @ApiPropertyOptional({ example: 19.076, description: 'Defaults to 0 when GPS is unavailable' })
  @IsOptional()
  @IsNumber()
  lat?: number;

  @ApiPropertyOptional({ example: 72.8777, description: 'Defaults to 0 when GPS is unavailable' })
  @IsOptional()
  @IsNumber()
  lng?: number;

  @ApiProperty({ example: 45, description: 'Minutes spent on-duty at this location' })
  @IsInt()
  @Min(1)
  minutes: number;
}
