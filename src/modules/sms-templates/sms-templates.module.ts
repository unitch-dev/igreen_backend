import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SmsTemplatesController } from './sms-templates.controller';
import { SmsTemplatesService } from './sms-templates.service';

@Module({
  imports: [PrismaModule],
  controllers: [SmsTemplatesController],
  providers: [SmsTemplatesService],
  exports: [SmsTemplatesService],
})
export class SmsTemplatesModule {}
