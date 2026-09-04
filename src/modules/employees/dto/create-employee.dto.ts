import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { EmploymentType } from '@prisma/client';
import {
  MOBILE_NUMBER_REGEX,
  MOBILE_NUMBER_VALIDATION_MESSAGE,
} from '../../../common/constants/mobile-number.constant';

export class CreateEmployeeDto {
  @ApiProperty() @IsString() @IsNotEmpty() firstName: string;
  @ApiProperty() @IsString() @IsNotEmpty() lastName: string;
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty({ example: '9876543210' })
  @IsString()
  @Matches(MOBILE_NUMBER_REGEX, { message: MOBILE_NUMBER_VALIDATION_MESSAGE })
  phone: string;

  @ApiProperty() @IsUUID() departmentId: string;
  @ApiProperty() @IsUUID() designationId: string;
  @ApiProperty() @IsUUID() payrollStructureId: string;
  @ApiProperty() @IsUUID() leavePolicyId: string;

  @ApiProperty({ enum: EmploymentType })
  @IsEnum(EmploymentType)
  employmentType: EmploymentType;

  @ApiProperty({ example: '2026-07-01' }) @IsDateString() joiningDate: string;

  @ApiPropertyOptional() @IsUUID() @IsOptional() reportingManagerId?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() empCode?: string;
  @ApiPropertyOptional() @IsDateString() @IsOptional() probationEndDate?: string;
  @ApiPropertyOptional() @IsDateString() @IsOptional() dateOfBirth?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gender?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() pfNumber?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() esiNumber?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() uanNumber?: string;
}
