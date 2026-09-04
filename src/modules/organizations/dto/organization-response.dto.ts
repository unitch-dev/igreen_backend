import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CurrencyCode } from '../../../common/enums/currency.enum';

export class OrganizationResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiPropertyOptional() logoUrl: string | null;
  @ApiPropertyOptional() address: string | null;
  @ApiPropertyOptional() phone: string | null;
  @ApiPropertyOptional() email: string | null;
  @ApiPropertyOptional() website: string | null;
  @ApiProperty({ enum: CurrencyCode, default: CurrencyCode.INR }) currency: CurrencyCode;
  @ApiProperty() isActive: boolean;
  @ApiProperty({
    default: true,
    description: 'Whether employees may raise service requests with isAnonymous: true',
  })
  allowAnonymousServiceRequests: boolean;
  @ApiProperty({ default: false, description: 'Whether the daily auto-logout cutoff is active' })
  autoLogoutEnabled: boolean;
  @ApiPropertyOptional({
    example: '21:30',
    nullable: true,
    description: 'Wall-clock cutoff in 24h "HH:mm" format, evaluated in autoLogoutTimezone',
  })
  autoLogoutTime: string | null;
  @ApiProperty({ default: 'Asia/Kolkata', description: 'IANA timezone for the auto-logout cutoff' })
  autoLogoutTimezone: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
