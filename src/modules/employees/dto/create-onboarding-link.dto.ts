import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmploymentType } from '@prisma/client';
import {
  MOBILE_NUMBER_REGEX,
  MOBILE_NUMBER_VALIDATION_MESSAGE,
} from '../../../common/constants/mobile-number.constant';

export class CreateOnboardingLinkDto {
  @ApiProperty({ example: 'raj.patel@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '9876543210', description: '10-digit mobile number' })
  @IsString()
  @Matches(MOBILE_NUMBER_REGEX, { message: MOBILE_NUMBER_VALIDATION_MESSAGE })
  phone: string;

  @ApiPropertyOptional({ example: 'Raj Patel', description: 'Pre-fill candidate name in form' })
  @IsString()
  @IsOptional()
  candidateName?: string;

  @ApiPropertyOptional({ example: 7, description: 'Link validity in days (1–30)', default: 7 })
  @IsInt()
  @Min(1)
  @Max(30)
  @IsOptional()
  @Type(() => Number)
  expiresInDays?: number;

  @ApiPropertyOptional({
    example: 'Rig Operator',
    description: 'Job title shown read-only on candidate form',
  })
  @IsString()
  @IsOptional()
  jobTitle?: string;

  @ApiPropertyOptional({
    example: 'Operations',
    description: 'Department name shown read-only on candidate form',
  })
  @IsString()
  @IsOptional()
  departmentName?: string;

  @ApiPropertyOptional({
    example: 'Mumbai Offshore',
    description: 'Work location shown read-only on candidate form',
  })
  @IsString()
  @IsOptional()
  workLocation?: string;

  @ApiPropertyOptional({
    example: '2026-04-10',
    description: 'Expected joining date shown read-only on candidate form',
  })
  @IsDateString()
  @IsOptional()
  prefillJoiningDate?: string;

  @ApiPropertyOptional({
    enum: EmploymentType,
    description: 'Employment type shown read-only on candidate form',
  })
  @IsEnum(EmploymentType)
  @IsOptional()
  prefillEmploymentType?: EmploymentType;
}
