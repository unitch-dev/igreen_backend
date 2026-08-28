import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '@prisma/prisma.service';

export type SmsTemplateKey =
  | 'otp'
  | 'onboardingWelcome'
  | 'onboardingInvite'
  | 'employeeInvite'
  | 'employeeWelcome';

export interface SendSmsResult {
  msgid: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('email.host'),
      port: this.config.get<number>('email.port'),
      auth: {
        user: this.config.get<string>('email.user'),
        pass: this.config.get<string>('email.pass'),
      },
    });
  }

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const from = this.config.get<string>('email.from');
    try {
      await this.transporter.sendMail({ from, to, subject, html });
    } catch (err) {
      this.logger.error(`Failed to send email to ${to}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Replaces every `{{token}}` in `message` with the matching value from
   * `variables`. Logs a warning (never throws) for any token left
   * unmatched, so a missing variable never crashes an SMS send.
   */
  private renderTemplate(message: string, variables: Record<string, string>): string {
    return message.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
      if (Object.prototype.hasOwnProperty.call(variables, token)) {
        return variables[token];
      }
      this.logger.warn(`SMS template placeholder {{${token}}} has no matching variable`);
      return match;
    });
  }

  async sendSms(
    phone: string,
    templateKey: SmsTemplateKey,
    variables: Record<string, string>,
  ): Promise<SendSmsResult | void> {
    const template = await this.prisma.smsTemplate.findUnique({ where: { key: templateKey } });
    if (!template || !template.isActive) {
      this.logger.error(`SMS template '${templateKey}' not found or inactive`);
      throw new Error(`SMS template '${templateKey}' not found or inactive`);
    }

    const message = this.renderTemplate(template.message, variables);

    const nodeEnv = this.config.get<string>('nodeEnv');
    if (nodeEnv !== 'production') {
      this.logger.log(`[DEV SMS] → ${phone}: ${message}`);
      return;
    }
    if (!template.tid) {
      this.logger.error(`SMS template '${templateKey}' has no DLT template id (tid) configured`);
      throw new Error(`SMS template '${templateKey}' has no DLT template id (tid) configured`);
    }
    const tid = template.tid;
    const senderid = template.senderId ?? this.config.get<string>('sms.smsHorizon.senderId');
    try {
      const axios = (await import('axios')).default;
      const params = new URLSearchParams({
        user: this.config.get<string>('sms.smsHorizon.user'),
        mobile: phone,
        senderid,
        message,
        tid,
        type: 'txt',
      });
      const res = await axios.post(
        'https://smshorizon.co.in/api/v2/sendsms.php',
        params.toString(),
        {
          headers: {
            Authorization: `Bearer ${this.config.get<string>('sms.smsHorizon.apiKey')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );
      // Surface provider-level failure distinctly from network errors so DLT rejections are debuggable
      if (res.data?.error) {
        this.logger.error(
          `SMSHorizon rejected SMS to ${phone} (template ${templateKey}): ${res.data.error}`,
        );
        throw new Error(`SMSHorizon error: ${res.data.error}`);
      }
      return { msgid: res.data.msgid };
    } catch (err) {
      this.logger.error(`Failed to send SMS to ${phone}: ${err.message}`);
      throw err;
    }
  }

  async checkSmsStatus(msgid: string): Promise<string> {
    const nodeEnv = this.config.get<string>('nodeEnv');
    if (nodeEnv !== 'production') {
      this.logger.log(`[DEV SMS STATUS] → msgid ${msgid}: DEV_STUB`);
      return 'DEV_STUB';
    }
    try {
      const axios = (await import('axios')).default;
      const params = new URLSearchParams({
        user: this.config.get<string>('sms.smsHorizon.user'),
        msgid,
      });
      const res = await axios.post(
        'https://smshorizon.co.in/api/v2/status.php',
        params.toString(),
        {
          headers: {
            Authorization: `Bearer ${this.config.get<string>('sms.smsHorizon.apiKey')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );
      if (res.data?.error) {
        this.logger.error(`SMSHorizon status check failed for msgid ${msgid}: ${res.data.error}`);
        throw new Error(`SMSHorizon status error: ${res.data.error}`);
      }
      return res.data.status;
    } catch (err) {
      this.logger.error(`Failed to check SMS status for msgid ${msgid}: ${err.message}`);
      throw err;
    }
  }
}
