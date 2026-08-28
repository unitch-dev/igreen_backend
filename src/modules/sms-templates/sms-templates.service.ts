import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@prisma/prisma.service';
import { UpdateSmsTemplateDto } from './dto/update-sms-template.dto';

// Global/system-wide table — intentionally NOT organizationId-scoped, see
// docs/modules/sms-templates.md. Do not add tenant filtering here.
@Injectable()
export class SmsTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.smsTemplate.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const template = await this.prisma.smsTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('SMS template not found');
    return template;
  }

  async update(id: string, dto: UpdateSmsTemplateDto) {
    const existing = await this.prisma.smsTemplate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('SMS template not found');

    return this.prisma.smsTemplate.update({
      where: { id },
      data: {
        message: dto.message,
        tid: dto.tid,
        senderId: dto.senderId,
        isActive: dto.isActive,
      },
    });
  }
}
