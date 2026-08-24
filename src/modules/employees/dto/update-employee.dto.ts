import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { CreateEmployeeDto } from './create-employee.dto';

// Admin-only full update DTO. Extends every CreateEmployeeDto field (all optional)
// plus the remaining Employee profile fields that PUT :id did not previously
// expose. This is the unrestricted, admin-gated (`employee:update`) surface —
// it intentionally includes departmentId, designationId, leavePolicyId,
// employmentType, workLocation and zoneId (the 5 admin-only fields) since
// this endpoint is only reachable with the `employee:update` permission.
// Self-service edits go through UpdateEmployeeSelfDto instead, which
// structurally omits those fields.
export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {
  @ApiPropertyOptional({ description: 'Zone assignment (GPS/attendance grouping)' })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({ example: 'Mumbai HO' })
  @IsOptional()
  @IsString()
  workLocation?: string;

  @ApiPropertyOptional({ example: 'Indian' })
  @IsOptional()
  @IsString()
  nationality?: string;

  @ApiPropertyOptional({ example: 'O+' })
  @IsOptional()
  @IsString()
  bloodGroup?: string;

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
