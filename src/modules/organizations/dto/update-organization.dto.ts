import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { CurrencyCode } from '../../../common/enums/currency.enum';

/**
 * Validates that a string is a real IANA timezone identifier by attempting
 * to construct an `Intl.DateTimeFormat` with it — the runtime throws a
 * `RangeError` for anything invalid.
 *
 * IMPORTANT: do NOT validate against `Intl.supportedValuesOf('timeZone')`
 * membership. That API returns only *canonical* zone names (e.g.
 * `Asia/Calcutta`) and excludes long-standing, still-valid IANA **links/
 * aliases** such as `Asia/Kolkata` — the exact default this codebase uses
 * everywhere else (`Organization.autoLogoutTimezone @default("Asia/Kolkata")`
 * in schema.prisma, the frontend timezone picker's first option, and every
 * `?? 'Asia/Kolkata'` fallback in auth.service.ts). A prior version of this
 * validator checked `supportedValuesOf(...).includes(value)` first, which
 * silently 400'd on the single most common value an Indian-HRMS org admin
 * would ever submit. `new Intl.DateTimeFormat('en-US', { timeZone: value })`
 * accepts both canonical names and aliases and is the correct universal
 * check — always prefer it over `supportedValuesOf` for validating a
 * *user-supplied* IANA zone string.
 */
function IsIanaTimezone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isIanaTimezone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || value.length === 0) return false;
          try {
            // eslint-disable-next-line no-new
            new Intl.DateTimeFormat('en-US', { timeZone: value });
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage() {
          return 'autoLogoutTimezone must be a valid IANA timezone identifier';
        },
      },
    });
  };
}

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ enum: CurrencyCode, example: CurrencyCode.INR })
  @IsEnum(CurrencyCode)
  @IsOptional()
  currency?: CurrencyCode;
  @ApiPropertyOptional({ example: 'IGreen Technologies' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/logo.png' })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsUrl()
  @IsOptional()
  logoUrl?: string;

  @ApiPropertyOptional({ example: '123 Business Park, Mumbai, MH 400001' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: 'admin@company.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: 'https://company.com' })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsUrl()
  @IsOptional()
  website?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'When true, employees who have not manually logged out are auto-logged-out ' +
      'at autoLogoutTime (in autoLogoutTimezone). Requires autoLogoutTime to be set.',
  })
  @IsBoolean()
  @IsOptional()
  autoLogoutEnabled?: boolean;

  @ApiPropertyOptional({
    example: '21:30',
    description:
      'Wall-clock cutoff time in 24-hour "HH:mm" format, evaluated in autoLogoutTimezone.',
  })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'autoLogoutTime must be in HH:mm 24-hour format',
  })
  @IsOptional()
  autoLogoutTime?: string;

  @ApiPropertyOptional({
    example: 'Asia/Kolkata',
    description: 'IANA timezone identifier the autoLogoutTime cutoff is evaluated in.',
  })
  @IsString()
  @IsIanaTimezone()
  @IsOptional()
  autoLogoutTimezone?: string;
}
