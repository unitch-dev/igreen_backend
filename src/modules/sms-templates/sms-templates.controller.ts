import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '@common/decorators/permissions.decorator';
import { ApiCommonErrorResponses, ApiSuccessResponse } from '@common/swagger/api-responses.decorator';
import { SmsTemplatesService } from './sms-templates.service';
import { UpdateSmsTemplateDto } from './dto/update-sms-template.dto';
import { SmsTemplateResponseDto } from './dto/sms-template-response.dto';

@ApiTags('SMS Templates')
@ApiBearerAuth()
@ApiCommonErrorResponses()
@Controller('sms-templates')
export class SmsTemplatesController {
  constructor(private readonly smsTemplatesService: SmsTemplatesService) {}

  @Get()
  @RequirePermissions('sms_template:read')
  @ApiOperation({
    summary: 'List all SMS templates',
    description:
      'Global/system-wide list (not tenant-scoped) of the fixed set of SMS templates used across ' +
      'the platform (OTP, onboarding, invite, welcome).',
  })
  @ApiSuccessResponse(SmsTemplateResponseDto, 'List of SMS templates', 200, true)
  findAll() {
    return this.smsTemplatesService.findAll();
  }

  @Get(':id')
  @RequirePermissions('sms_template:read')
  @ApiOperation({ summary: 'Get a single SMS template' })
  @ApiParam({ name: 'id', description: 'SmsTemplate UUID' })
  @ApiSuccessResponse(SmsTemplateResponseDto, 'SMS template detail')
  findOne(@Param('id') id: string) {
    return this.smsTemplatesService.findOne(id);
  }

  @Put(':id')
  @RequirePermissions('sms_template:update')
  @ApiOperation({
    summary: 'Update an SMS template',
    description: 'Updates message/tid/senderId/isActive only — key and name are system-defined.',
  })
  @ApiParam({ name: 'id', description: 'SmsTemplate UUID' })
  @ApiSuccessResponse(SmsTemplateResponseDto, 'SMS template updated')
  update(@Param('id') id: string, @Body() dto: UpdateSmsTemplateDto) {
    return this.smsTemplatesService.update(id, dto);
  }
}
