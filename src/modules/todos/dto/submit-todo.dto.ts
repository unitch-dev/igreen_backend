import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class SubmitTodoDto {
  @ApiProperty({ example: 20, minimum: 0, description: 'Completed quantity being submitted' })
  @IsNumber()
  @Min(0)
  quantity: number;

  @ApiPropertyOptional({ example: 'parcels' })
  @IsOptional()
  @IsString()
  unit?: string;
}
