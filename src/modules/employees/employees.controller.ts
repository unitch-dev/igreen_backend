import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ApiCommonErrorResponses } from '../../common/swagger/api-responses.decorator';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { UpdateEmployeeSelfDto } from './dto/update-employee-self.dto';
import { PatchEmployeeStatusDto } from './dto/patch-employee-status.dto';
import { EmployeeQueryDto } from './dto/employee-query.dto';
import { UpdateBankDetailsDto } from './dto/update-bank-details.dto';
import { UpdateEmergencyContactDto } from './dto/update-emergency-contact.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';

// Mirrors OnboardingPublicController's Multer convention (see rule §27 in
// .claude/agents/hrms-backend.md) — every multipart upload endpoint MUST set
// an explicit fileFilter allowlist + a fileSize limit, Multer accepts
// anything by default otherwise.
const MAX_UPLOAD_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_DOCUMENT_MIMETYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const ALLOWED_IMAGE_MIMETYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

@ApiTags('Employees')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get('stats')
  @RequirePermissions('employee:read')
  @ApiOperation({ summary: 'Employee aggregate stats (no pagination)' })
  getStats(@CurrentUser('organizationId') organizationId: string) {
    return this.employeesService.getStats(organizationId);
  }

  @Get('trash')
  @RequirePermissions('employee:read')
  @ApiOperation({ summary: 'List soft-deleted employees' })
  findTrashed(
    @CurrentUser('organizationId') organizationId: string,
    @Query() query: EmployeeQueryDto,
  ) {
    return this.employeesService.findTrashed(organizationId, query);
  }

  @Post()
  @RequirePermissions('employee:create')
  @ApiOperation({
    summary: 'Create employee directly (bypasses onboarding)',
    description:
      'Validates dept/designation/manager, creates Employee + User in a single transaction with temp password, and sends onboarding invite email.',
  })
  create(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateEmployeeDto,
  ) {
    return this.employeesService.create(organizationId, dto, userId);
  }

  @Get()
  @RequirePermissions('employee:read')
  @ApiOperation({
    summary: 'List employees',
    description: 'Paginated. Filter by ?status=ACTIVE&departmentId=...&employmentType=FULL_TIME',
  })
  findAll(@CurrentUser('organizationId') organizationId: string, @Query() query: EmployeeQueryDto) {
    return this.employeesService.findAll(organizationId, query);
  }

  @Get(':id')
  @RequirePermissions('employee:read')
  @ApiOperation({
    summary: 'Get employee full profile',
    description:
      'Includes department, designation, reporting manager, payroll structure, leave policy, and user account info.',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  findOne(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.employeesService.findOne(organizationId, id);
  }

  @Put(':id')
  @RequirePermissions('employee:update')
  @ApiOperation({ summary: 'Update employee fields' })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  update(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(organizationId, id, dto, userId);
  }

  @Patch(':id/self')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('profile:update')
  @ApiOperation({
    summary: 'Self-service: update my own personal details',
    description:
      'Any authenticated employee may call this for their OWN record only (403 otherwise). ' +
      'Whitelists personal-information fields only (dateOfBirth, gender, nationality, ' +
      'bloodGroup, phone, email, address, healthInfo, previousEmployment, referenceContacts, ' +
      'profilePhotoUrl). Department, designation, leave policy, work location/zone, and ' +
      'employment type can only be changed via the admin PUT :id endpoint.',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID (must be your own)' })
  updateSelf(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('employeeId') callerEmployeeId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeSelfDto,
  ) {
    return this.employeesService.updateSelf(organizationId, id, dto, callerEmployeeId);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employee:update')
  @ApiOperation({
    summary: 'Change employee status',
    description:
      'Valid transitions: PRE_BOARDING→ACTIVE/EXITED, ACTIVE→ON_LEAVE/SUSPENDED/EXITED. A reason is required when transitioning to SUSPENDED or EXITED. Sending ACTIVE triggers a welcome email.',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  patchStatus(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: PatchEmployeeStatusDto,
  ) {
    return this.employeesService.patchStatus(organizationId, id, dto, userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employee:delete')
  @ApiOperation({ summary: 'Soft-delete employee' })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  remove(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.employeesService.remove(organizationId, id, userId);
  }

  @Patch(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employee:update')
  @ApiOperation({ summary: 'Restore soft-deleted employee' })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  restore(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.employeesService.restore(organizationId, id, userId);
  }

  // ─── Document & Photo Upload ──────────────────────────────────────────────────

  @Post(':id/documents')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES },
      fileFilter: (req, file, cb) => {
        if (!ALLOWED_DOCUMENT_MIMETYPES.includes(file.mimetype)) {
          cb(new BadRequestException('Only PDF, JPG, and PNG files are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload an identity or HR document',
    description:
      "Adds the document entry to the employee's documents JSON array. " +
      "Callable by the employee for their OWN record, or by anyone holding 'employee:update'. " +
      'Max 5 MB; PDF, JPG, or PNG only.',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiResponse({
    status: 200,
    description: 'Document uploaded and appended to the employee documents array.',
    schema: {
      example: {
        success: true,
        data: {
          documents: [
            {
              type: 'AADHAAR',
              fileName: 'aadhaar.pdf',
              fileUrl:
                'https://api.example.com/uploads/EMPLOYEE_DOCUMENT/org-1/emp-1/uuid-aadhaar.pdf',
              fileAssetId: 'a1b2c3d4-...-fileasset',
              notes: null,
              uploadedAt: '2026-08-24T10:10:00.000Z',
              uploadedBy: 'user-1',
            },
          ],
        },
        timestamp: '2026-08-24T10:10:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Rejected file — disallowed mimetype (only PDF/JPG/PNG accepted) or missing documentType',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'documentType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        documentType: {
          type: 'string',
          enum: [
            'AADHAAR',
            'PAN',
            'PASSPORT',
            'DRIVING_LICENCE',
            'VOTER_ID',
            'DEGREE',
            'RESUME',
            'OFFER_LETTER',
            'EXPERIENCE_LETTER',
            'OTHER',
          ],
        },
        notes: { type: 'string' },
      },
    },
  })
  uploadDocument(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('employeeId') callerEmployeeId: string,
    @CurrentUser('permissions') callerPermissions: string[],
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
  ) {
    return this.employeesService.uploadDocument(
      organizationId,
      id,
      file,
      dto,
      userId,
      callerEmployeeId,
      callerPermissions,
    );
  }

  @Post(':id/profile-photo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES },
      fileFilter: (req, file, cb) => {
        if (!ALLOWED_IMAGE_MIMETYPES.includes(file.mimetype)) {
          cb(new BadRequestException('Only JPG, PNG, and WEBP images are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload employee profile photo',
    description:
      'Replaces any existing profile photo. Old file is deleted from storage. ' +
      "Callable by the employee for their OWN record, or by anyone holding 'employee:update'. " +
      'Max 5 MB; JPG, PNG, or WEBP only.',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Profile photo uploaded; employee.profilePhotoUrl updated.',
    schema: {
      example: {
        success: true,
        data: {
          id: 'emp-1',
          profilePhotoUrl:
            'https://api.example.com/uploads/EMPLOYEE_PROFILE_PHOTO/org-1/emp-1/uuid-photo.jpg',
        },
        timestamp: '2026-08-24T10:10:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Rejected file — only JPG, PNG, or WEBP images under 5 MB are accepted',
  })
  uploadProfilePhoto(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('employeeId') callerEmployeeId: string,
    @CurrentUser('permissions') callerPermissions: string[],
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.employeesService.uploadProfilePhoto(
      organizationId,
      id,
      file,
      userId,
      callerEmployeeId,
      callerPermissions,
    );
  }

  // ─── Bank Details & Emergency Contact ────────────────────────────────────────

  @Patch(':id/bank-details')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update employee bank details',
    description:
      "Callable by the employee for their OWN record, or by anyone holding 'employee:update'.",
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  updateBankDetails(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('employeeId') callerEmployeeId: string,
    @CurrentUser('permissions') callerPermissions: string[],
    @Param('id') id: string,
    @Body() dto: UpdateBankDetailsDto,
  ) {
    return this.employeesService.updateBankDetails(
      organizationId,
      id,
      dto,
      userId,
      callerEmployeeId,
      callerPermissions,
    );
  }

  @Patch(':id/emergency-contact')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update employee emergency contact',
    description:
      "Callable by the employee for their OWN record, or by anyone holding 'employee:update'.",
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  updateEmergencyContact(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('employeeId') callerEmployeeId: string,
    @CurrentUser('permissions') callerPermissions: string[],
    @Param('id') id: string,
    @Body() dto: UpdateEmergencyContactDto,
  ) {
    return this.employeesService.updateEmergencyContact(
      organizationId,
      id,
      dto,
      userId,
      callerEmployeeId,
      callerPermissions,
    );
  }

  // ─── Reporting Hierarchy ──────────────────────────────────────────────────────

  @Get(':id/subordinates')
  @RequirePermissions('employee:read')
  @ApiOperation({
    summary: 'Get subordinate tree',
    description:
      'Returns a nested tree of all direct and indirect reports up to the specified depth.',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiQuery({
    name: 'depth',
    required: false,
    type: Number,
    description: 'Maximum depth of the tree (default 5, max 10)',
    example: 3,
  })
  getSubordinates(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query('depth', new ParseIntPipe({ optional: true })) depth?: number,
  ) {
    const safeDepth = Math.min(depth ?? 5, 10);
    return this.employeesService.getSubordinates(organizationId, id, safeDepth);
  }

  @Get(':id/reporting-chain')
  @RequirePermissions('employee:read')
  @ApiOperation({
    summary: 'Get reporting chain to root',
    description:
      "Returns an ordered array from the employee's direct manager up to the top of the hierarchy.",
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  getReportingChain(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.employeesService.getReportingChain(organizationId, id);
  }

  // ─── Password Reset ───────────────────────────────────────────────────────────

  @Post(':id/send-password-reset')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employee:update')
  @ApiOperation({
    summary: 'Admin: send password reset email to employee',
    description:
      'Generates a 24-hour reset token, stores it in Redis, and sends the employee an email with a reset link. A confirmation email is sent automatically after the password is changed.',
  })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  sendPasswordResetEmail(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.employeesService.sendPasswordResetEmail(organizationId, id);
  }
}
