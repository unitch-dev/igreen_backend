import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEmployeeDto } from '../../modules/employees/dto/create-employee.dto';
import { UpdateEmergencyContactDto } from '../../modules/employees/dto/update-emergency-contact.dto';
import { CreateOnboardingLinkDto } from '../../modules/employees/dto/create-onboarding-link.dto';
import { UpdateEmployeeSelfDto } from '../../modules/employees/dto/update-employee-self.dto';
import { SubmitDetailsDto, Gender } from '../../modules/employees/dto/submit-details.dto';
import { EmploymentType } from '@prisma/client';

/**
 * Unit-level coverage for the shared MOBILE_NUMBER_REGEX (`^\d{10}$`)
 * enforcement across every genuine mobile field touched by the
 * mobile-number-validation feature (see
 * docs/modules/auto-logout-and-mobile-validation.md, Feature 2). Runs
 * class-validator directly against each DTO — no HTTP/DB required — for a
 * fast, deterministic check that non-10-digit input 400s (fails validation)
 * and a genuine 10-digit value passes.
 */
describe('Mobile number validation (unit, DTO-level)', () => {
  const INVALID_VALUES = ['98765432', '987654321012', '98765abcde', '+919876543210', '9876-543210'];
  const VALID_VALUE = '9876543210';

  describe('CreateEmployeeDto.phone', () => {
    const base = {
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      departmentId: '11111111-1111-1111-1111-111111111111',
      designationId: '11111111-1111-1111-1111-111111111111',
      payrollStructureId: '11111111-1111-1111-1111-111111111111',
      leavePolicyId: '11111111-1111-1111-1111-111111111111',
      employmentType: EmploymentType.FULL_TIME,
      joiningDate: '2026-01-01',
    };

    it.each(INVALID_VALUES)('rejects invalid phone "%s"', async (phone) => {
      const dto = plainToInstance(CreateEmployeeDto, { ...base, phone });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(true);
    });

    it('accepts a valid 10-digit phone', async () => {
      const dto = plainToInstance(CreateEmployeeDto, { ...base, phone: VALID_VALUE });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(false);
    });
  });

  describe('UpdateEmergencyContactDto.phone / .alternatePhone', () => {
    const base = { name: 'Priya Sharma', relation: 'Spouse' };

    it.each(INVALID_VALUES)('rejects invalid phone "%s"', async (phone) => {
      const dto = plainToInstance(UpdateEmergencyContactDto, { ...base, phone });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(true);
    });

    it.each(INVALID_VALUES)('rejects invalid alternatePhone "%s"', async (alternatePhone) => {
      const dto = plainToInstance(UpdateEmergencyContactDto, {
        ...base,
        phone: VALID_VALUE,
        alternatePhone,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'alternatePhone')).toBe(true);
    });

    it('accepts valid phone + alternatePhone', async () => {
      const dto = plainToInstance(UpdateEmergencyContactDto, {
        ...base,
        phone: VALID_VALUE,
        alternatePhone: '9123456789',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('alternatePhone is optional — omitting it entirely is valid', async () => {
      const dto = plainToInstance(UpdateEmergencyContactDto, { ...base, phone: VALID_VALUE });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('CreateOnboardingLinkDto.phone', () => {
    const base = { email: 'candidate@example.com' };

    it.each(INVALID_VALUES)('rejects invalid phone "%s"', async (phone) => {
      const dto = plainToInstance(CreateOnboardingLinkDto, { ...base, phone });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(true);
    });

    it('accepts a valid 10-digit phone', async () => {
      const dto = plainToInstance(CreateOnboardingLinkDto, { ...base, phone: VALID_VALUE });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(false);
    });
  });

  describe('UpdateEmployeeSelfDto.phone (optional)', () => {
    it.each(INVALID_VALUES)('rejects invalid phone "%s"', async (phone) => {
      const dto = plainToInstance(UpdateEmployeeSelfDto, { phone });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(true);
    });

    it('accepts a valid 10-digit phone', async () => {
      const dto = plainToInstance(UpdateEmployeeSelfDto, { phone: VALID_VALUE });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(false);
    });

    it('is optional — omitting phone entirely is valid', async () => {
      const dto = plainToInstance(UpdateEmployeeSelfDto, {});
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(false);
    });
  });

  describe('SubmitDetailsDto.phone + nested EmergencyContactDto.phone', () => {
    const base = {
      firstName: 'Raj',
      lastName: 'Patel',
      dateOfBirth: '1995-04-12',
      gender: Gender.MALE,
      address: { line1: '1 MG Road', city: 'Mumbai', state: 'MH', pincode: '400001' },
      bankName: 'HDFC Bank',
      accountNumber: '123456789012',
      ifscCode: 'HDFC0001234',
      accountType: 'SAVINGS',
      declarationAccepted: true,
    };

    it.each(INVALID_VALUES)('rejects invalid top-level phone "%s"', async (phone) => {
      const dto = plainToInstance(SubmitDetailsDto, { ...base, phone });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(true);
    });

    it('accepts a valid top-level phone', async () => {
      const dto = plainToInstance(SubmitDetailsDto, { ...base, phone: VALID_VALUE });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'phone')).toBe(false);
    });

    it.each(INVALID_VALUES)('rejects invalid nested emergencyContact.phone "%s"', async (phone) => {
      const dto = plainToInstance(SubmitDetailsDto, {
        ...base,
        emergencyContact: { name: 'Priya Patel', relation: 'Spouse', phone },
      });
      const errors = await validate(dto);
      const nested = errors.find((e) => e.property === 'emergencyContact');
      expect(nested).toBeDefined();
      expect(nested?.children?.some((c) => c.property === 'phone')).toBe(true);
    });

    it('accepts a valid nested emergencyContact.phone', async () => {
      const dto = plainToInstance(SubmitDetailsDto, {
        ...base,
        emergencyContact: { name: 'Priya Patel', relation: 'Spouse', phone: VALID_VALUE },
      });
      const errors = await validate(dto);
      expect(errors.find((e) => e.property === 'emergencyContact')).toBeUndefined();
    });
  });
});
