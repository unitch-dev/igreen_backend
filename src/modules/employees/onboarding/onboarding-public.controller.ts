import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FileEntityType } from '@prisma/client';
import { Public } from '../../../common/decorators/public.decorator';
import { OnboardingService } from './onboarding.service';
import { SubmitDetailsDto } from '../dto/submit-details.dto';
import { FilesService } from '../../files/files.service';

const ALLOWED_DOCUMENT_MIMETYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const MAX_DOCUMENT_FILE_SIZE_BYTES = 5 * 1024 * 1024;

@ApiTags('Onboarding (Candidate)')
@Public()
@Throttle({ default: { limit: 15, ttl: 60000 } })
@Controller('onboarding/public')
export class OnboardingPublicController {
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly filesService: FilesService,
  ) {}

  @Get(':token')
  @ApiOperation({
    summary: 'Repopulate form',
    description:
      'Returns current onboarding state and all previously saved submission data for form repopulation. If status is CHANGES_REQUESTED, auto-transitions to IN_PROGRESS.',
  })
  @ApiParam({ name: 'token', description: '48-char hex onboarding token' })
  getForm(@Param('token') token: string) {
    return this.onboardingService.getPublicLink(token);
  }

  @Put(':token/details')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit personal + bank details (Step 1)',
    description:
      'Saves personal info and bank details in a single call. Idempotent — can be called again to correct before documents are submitted. Transitions PENDING → IN_PROGRESS on first call.',
  })
  @ApiParam({ name: 'token', description: '48-char hex onboarding token' })
  submitDetails(@Param('token') token: string, @Body() dto: SubmitDetailsDto) {
    return this.onboardingService.submitDetails(token, dto);
  }

  @Post(':token/documents')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: { fileSize: MAX_DOCUMENT_FILE_SIZE_BYTES },
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
    summary: 'Upload documents + final submit (Step 2)',
    description:
      'Accepts one or more document files with their types. Upload files in batches. Set finalSubmit=true in the form field to trigger SUBMITTED transition (all docs must already be uploaded). Blocked if Step 1 not completed. Each file is limited to 5 MB and must be application/pdf, image/jpeg, image/jpg, or image/png.',
  })
  @ApiResponse({
    status: 200,
    description: 'Documents uploaded (and, if finalSubmit=true, onboarding submitted for review).',
    schema: {
      example: {
        success: true,
        data: {
          uploaded: [
            {
              type: 'AADHAAR',
              fileName: 'aadhaar.pdf',
              fileUrl:
                'https://api.example.com/uploads/ONBOARDING_DOCUMENT/org-1/unassigned/uuid-aadhaar.pdf',
              fileAssetId: 'a1b2c3d4-...-fileasset',
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
      'Bad request — either a rejected file (disallowed mimetype; only PDF/JPG/PNG accepted) or Step 1 (personal + bank details) has not been completed yet.',
  })
  @ApiResponse({
    status: 413,
    description: 'A file exceeds the 5 MB per-file size limit.',
  })
  @ApiResponse({
    status: 503,
    description: 'File storage is currently unavailable. Retry later.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
        documentTypes: {
          type: 'array',
          items: {
            type: 'string',
            description:
              'Predefined types: AADHAAR, PAN, RESUME, OFFER_LETTER, BANK_PROOF, PHOTO, EDUCATION_CERTIFICATE, EXPERIENCE_CERTIFICATE, BLOOD_GROUP_REPORT',
          },
          description: 'Parallel array of document type labels matching the uploaded files',
        },
        finalSubmit: {
          type: 'string',
          enum: ['true', 'false'],
          description: 'Set to true to finalise submission',
        },
      },
    },
  })
  @ApiParam({ name: 'token', description: '48-char hex onboarding token' })
  async submitDocuments(
    @Param('token') token: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('documentTypes') documentTypes: string | string[],
    @Body('finalSubmit') finalSubmit: string,
  ) {
    // Validate business preconditions (link status, expiry, "details" step
    // completed) BEFORE touching storage — see OnboardingService.assertCanSubmitDocuments.
    const { organizationId } = await this.onboardingService.assertCanSubmitDocuments(token);

    const typesArray = Array.isArray(documentTypes) ? documentTypes : [documentTypes];
    const doFinalSubmit = finalSubmit === 'true';

    const uploaded: Array<{
      type: string;
      fileName: string;
      fileUrl: string;
      fileAssetId: string;
    }> = [];

    if (files?.length) {
      await Promise.all(
        files.map(async (file, i) => {
          // PUBLIC route — no authenticated user and no Employee record exists
          // yet at this point in the flow, so `entityId`/`uploadedById` are
          // intentionally left undefined (the file is bucketed under
          // `.../unassigned/...`). The onboarding token itself lives on
          // `OnboardingLink.submissionData`, not on the FileAsset. The
          // `fileAssetId` is preserved in the submission data so the file can
          // be re-tagged/moved once the Employee record is created.
          const asset = await this.filesService.upload({
            buffer: file.buffer,
            organizationId,
            entityType: FileEntityType.ONBOARDING_DOCUMENT,
            category: typesArray[i] ?? 'OTHER',
            fileName: file.originalname,
            mimeType: file.mimetype,
          });
          uploaded.push({
            type: typesArray[i] ?? 'OTHER',
            fileName: asset.fileName,
            fileUrl: asset.url,
            fileAssetId: asset.id,
          });
        }),
      );
    }

    return this.onboardingService.submitDocuments(token, uploaded, doFinalSubmit);
  }
}
