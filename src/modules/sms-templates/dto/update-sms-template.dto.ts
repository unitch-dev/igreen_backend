import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateSmsTemplateDto {
  @ApiProperty({ description: 'Rendered message template with {{placeholder}} tokens' })
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'DLT template id registered with the SMS provider',
  })
  @IsOptional()
  @IsString()
  tid?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Override sender id; falls back to the org-wide default',
  })
  @IsOptional()
  @IsString()
  senderId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
