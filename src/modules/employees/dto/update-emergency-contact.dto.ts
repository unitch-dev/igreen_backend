import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import {
  MOBILE_NUMBER_REGEX,
  MOBILE_NUMBER_VALIDATION_MESSAGE,
} from '../../../common/constants/mobile-number.constant';

export class UpdateEmergencyContactDto {
  @ApiProperty({ example: 'Priya Sharma' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '9876543210' })
  @IsString()
  @Matches(MOBILE_NUMBER_REGEX, { message: MOBILE_NUMBER_VALIDATION_MESSAGE })
  phone: string;

  @ApiProperty({ example: 'Spouse' })
  @IsString()
  @IsNotEmpty()
  relation: string;

  @ApiPropertyOptional({ example: '9123456789' })
  @IsOptional()
  @IsString()
  @Matches(MOBILE_NUMBER_REGEX, { message: MOBILE_NUMBER_VALIDATION_MESSAGE })
  alternatePhone?: string;

  @ApiPropertyOptional({ example: '123 Main St, Mumbai' })
  @IsOptional()
  @IsString()
  address?: string;
}
