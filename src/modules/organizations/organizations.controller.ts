import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ApiCommonErrorResponses } from '../../common/swagger/api-responses.decorator';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationResponseDto } from './dto/organization-response.dto';
import { OrganizationsService } from './organizations.service';

// Mirrors the image-only + 5 MB validation used by the onboarding document
// upload endpoint (`onboarding-public.controller.ts`) — every multipart
// upload endpoint MUST set an explicit fileFilter + limits; Multer accepts
// anything unbounded by default.
const ALLOWED_LOGO_MIMETYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/svg+xml',
];
const MAX_LOGO_FILE_SIZE_BYTES = 5 * 1024 * 1024;

@ApiTags('Organizations')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('organization')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get()
  @RequirePermissions('org:read')
  @ApiOperation({
    summary: 'Get organization profile',
    description: 'Returns the profile of the current organization.',
  })
  @ApiResponse({ status: 200, description: 'Organization profile', type: OrganizationResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing permission: org:read' })
  findOne(@CurrentUser('organizationId') organizationId: string) {
    return this.organizationsService.findOne(organizationId);
  }

  @Put()
  @RequirePermissions('org:update')
  @ApiOperation({
    summary: 'Update organization profile',
    description:
      'Updates the organization name, contact details, or logo URL. Slug and active status cannot be changed here.',
  })
  @ApiResponse({ status: 200, description: 'Organization updated', type: OrganizationResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error or email collision' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing permission: org:update' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  update(
    @CurrentUser('organizationId') organizationId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.update(organizationId, dto);
  }

  @Post('logo')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('org:update')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_LOGO_FILE_SIZE_BYTES },
      fileFilter: (req, file, cb) => {
        if (!ALLOWED_LOGO_MIMETYPES.includes(file.mimetype)) {
          cb(new BadRequestException('Only JPG, PNG, WEBP, or SVG images are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload organization logo',
    description:
      'Replaces any existing organization logo. Old file is deleted from storage. Max 5 MB; ' +
      'JPG, PNG, WEBP, or SVG only.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 200, description: 'Logo uploaded', type: OrganizationResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation error — non-image file or file exceeds 5 MB',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing permission: org:update' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  uploadLogo(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('id') userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.organizationsService.uploadLogo(organizationId, file, userId);
  }
}
