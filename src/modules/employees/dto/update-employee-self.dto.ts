import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  MOBILE_NUMBER_REGEX,
  MOBILE_NUMBER_VALIDATION_MESSAGE,
} from '../../../common/constants/mobile-number.constant';

// Self-service personal-details update DTO, used by PATCH /employees/:id/self.
// Structurally whitelists ONLY personal-information fields — the 5 admin-only
// fields (departmentId, leavePolicyId, designationId, workLocation/zoneId,
// employmentType) are absent from this class entirely, so no permission
// combination can smuggle them through this endpoint. Bank details, emergency
// contact, and documents have their own dedicated PATCH/POST endpoints.
export class UpdateEmployeeSelfDto {
  @ApiPropertyOptional({ example: '1995-04-12' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'Male' })
  @IsOptional()
  @IsString()
  gender?: string;

  @ApiPropertyOptional({ example: 'Indian' })
  @IsOptional()
  @IsString()
  nationality?: string;

  @ApiPropertyOptional({ example: 'O+' })
  @IsOptional()
  @IsString()
  bloodGroup?: string;

  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @IsString()
  @Matches(MOBILE_NUMBER_REGEX, { message: MOBILE_NUMBER_VALIDATION_MESSAGE })
  phone?: string;

  @ApiPropertyOptional({ example: 'employee.personal@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  address?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  healthInfo?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, isArray: true })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  previousEmployment?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, isArray: true })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  referenceContacts?: Record<string, unknown>[];

  @ApiPropertyOptional({ example: 'https://files.example.com/uploads/photos/abc.jpg' })
  @IsOptional()
  @IsString()
  profilePhotoUrl?: string;
}
