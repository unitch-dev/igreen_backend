import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { NotificationsService } from '../../notifications/notifications.service';

interface WelcomeJobData {
  empCode: string;
  firstName: string;
  email: string;
  phone: string;
  tempPassword: string;
}

interface InviteJobData {
  token: string;
  email: string;
  phone: string;
  candidateName?: string;
  expiresAt: string;
}

@Processor('onboarding')
export class OnboardingProcessor extends WorkerHost {
  private readonly logger = new Logger(OnboardingProcessor.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'onboarding.welcome') {
      await this.handleWelcome(job.data as WelcomeJobData);
    } else if (job.name === 'onboarding.invite') {
      await this.handleInvite(job.data as InviteJobData);
    }
  }

  private async handleWelcome(data: WelcomeJobData) {
    const html = `
      <h2>Welcome to the team, ${data.firstName}!</h2>
      <p>Your employee account has been created. Please use the following credentials to log in:</p>
      <table>
        <tr><td><strong>Employee ID</strong></td><td>${data.empCode}</td></tr>
        <tr><td><strong>Login Email</strong></td><td>${data.email}</td></tr>
        <tr><td><strong>Password</strong></td><td>${data.tempPassword}</td></tr>
      </table>
      <p>⚠️ You will be required to change this password immediately upon first login.</p>
      <p>If you did not expect this email, please contact HR.</p>
    `;

    await Promise.allSettled([
      this.notifications.sendEmail(data.email, 'Welcome — Your HRMS Login Credentials', html),
      this.notifications.sendSms(data.phone, 'onboardingWelcome', {
        empCode: data.empCode,
        email: data.email,
        tempPassword: data.tempPassword,
      }),
    ]);

    this.logger.log(`Welcome notification sent for ${data.empCode}`);
  }

  private async handleInvite(data: InviteJobData) {
    // The onboarding link is a FRONTEND route (/onboarding/:token), not a
    // backend one — must use frontendUrl (the frontend's public origin), not
    // appUrl (the backend's own address, used for serving uploaded files).
    // Using appUrl here previously sent candidates a link pointing at the
    // API server instead of the SPA.
    const frontendUrl = this.config.get<string>('frontendUrl');
    const link = `${frontendUrl}/onboarding/${data.token}`;
    const html = `
      <h2>You've been invited to join our team!</h2>
      <p>Dear ${data.candidateName ?? 'Candidate'},</p>
      <p>Please complete your onboarding by clicking the link below:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires on ${new Date(data.expiresAt).toLocaleDateString()}.</p>
    `;

    await Promise.allSettled([
      this.notifications.sendEmail(data.email, 'Complete Your Onboarding', html),
      this.notifications.sendSms(data.phone, 'onboardingInvite', { link }),
    ]);

    this.logger.log(`Invite notification sent to ${data.email}`);
  }
}
