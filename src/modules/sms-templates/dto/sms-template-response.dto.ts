import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SmsTemplateResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  key: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  message: string;

  @ApiPropertyOptional({ nullable: true })
  tid: string | null;

  @ApiPropertyOptional({ nullable: true })
  senderId: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
