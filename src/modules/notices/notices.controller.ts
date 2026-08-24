import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { OrganizationId } from '@common/decorators/organization.decorator';
import { RequirePermissions } from '@common/decorators/permissions.decorator';
import {
  ApiCommonErrorResponses,
  ApiPaginatedResponse,
  ApiSuccessResponse,
} from '@common/swagger/api-responses.decorator';
import { NoticesService, RequestingUser } from './notices.service';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { UpdateNoticeDto } from './dto/update-notice.dto';
import { QueryNoticeDto } from './dto/query-notice.dto';
import {
  NoticeResponseDto,
  NoticeDeleteResponseDto,
  NoticeMarkReadResponseDto,
} from './dto/notice-response.dto';
import { NoticeReadReceiptResponseDto } from './dto/notice-read-receipt-response.dto';

@ApiTags('Notices')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('notices')
export class NoticesController {
  constructor(private readonly noticesService: NoticesService) {}

  @Post()
  @RequirePermissions('notice:manage')
  @ApiOperation({ summary: 'Create a notice (draft, scheduled, or published immediately)' })
  @ApiSuccessResponse(NoticeResponseDto, 'Notice created', 201)
  create(@OrganizationId() organizationId: string, @Body() dto: CreateNoticeDto) {
    return this.noticesService.create(organizationId, dto);
  }

  @Get()
  @RequirePermissions('notice:read')
  @ApiOperation({
    summary: 'List notices (paginated)',
    description:
      '?view=board (default) returns published/due-scheduled notices visible to the caller with ' +
      '`hasRead`. ?view=manage returns all org notices with `readCount` and additionally requires ' +
      'onboarding:manage. Optional ?status=draft|scheduled|published.',
  })
  @ApiPaginatedResponse(NoticeResponseDto, 'Paginated list of notices')
  findAll(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Query() query: QueryNoticeDto,
  ) {
    return this.noticesService.findAll(organizationId, currentUser, query);
  }

  @Get(':id')
  @RequirePermissions('notice:read')
  @ApiOperation({ summary: 'Get a single notice (honors visibility/targeting for non-managers)' })
  @ApiParam({ name: 'id', description: 'Notice UUID' })
  @ApiSuccessResponse(NoticeResponseDto, 'Notice detail')
  findOne(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Param('id') id: string,
  ) {
    return this.noticesService.findOne(organizationId, currentUser, id);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notice:manage')
  @ApiOperation({
    summary: 'Update a notice (draft/scheduled only — published notices are locked)',
  })
  @ApiParam({ name: 'id', description: 'Notice UUID' })
  @ApiSuccessResponse(NoticeResponseDto, 'Notice updated')
  update(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Body() dto: UpdateNoticeDto,
  ) {
    return this.noticesService.update(organizationId, id, dto);
  }

  @Put(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notice:manage')
  @ApiOperation({ summary: 'Publish a draft or scheduled notice immediately' })
  @ApiParam({ name: 'id', description: 'Notice UUID' })
  @ApiSuccessResponse(NoticeResponseDto, 'Notice published')
  publish(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.noticesService.publish(organizationId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notice:manage')
  @ApiOperation({ summary: 'Delete a notice (and its attachment, if any)' })
  @ApiParam({ name: 'id', description: 'Notice UUID' })
  @ApiSuccessResponse(NoticeDeleteResponseDto, 'Notice deleted')
  remove(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.noticesService.remove(organizationId, id);
  }

  @Post(':id/attachment')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notice:manage')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Attach a file to a notice' })
  @ApiParam({ name: 'id', description: 'Notice UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiSuccessResponse(NoticeResponseDto, 'Attachment uploaded')
  uploadAttachment(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.noticesService.uploadAttachment(organizationId, id, file);
  }

  @Put(':id/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notice:read')
  @ApiOperation({ summary: 'Mark a notice as read by the current employee (idempotent)' })
  @ApiParam({ name: 'id', description: 'Notice UUID' })
  @ApiSuccessResponse(NoticeMarkReadResponseDto, 'Notice marked as read')
  markRead(
    @OrganizationId() organizationId: string,
    @CurrentUser() currentUser: RequestingUser,
    @Param('id') id: string,
  ) {
    return this.noticesService.markRead(organizationId, currentUser, id);
  }

  @Get(':id/read-receipts')
  @RequirePermissions('notice:manage')
  @ApiOperation({ summary: 'List employees who have read a notice (paginated)' })
  @ApiParam({ name: 'id', description: 'Notice UUID' })
  @ApiPaginatedResponse(NoticeReadReceiptResponseDto, 'Paginated list of read receipts')
  getReadReceipts(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Query() query: QueryNoticeDto,
  ) {
    return this.noticesService.getReadReceipts(organizationId, id, query);
  }
}
