import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { NotificationsService } from '../../notifications/notifications.service';

interface OnboardingInviteJobData {
  employeeId: string;
  email: string;
  phone: string;
  firstName: string;
  empCode: string;
  tempPassword: string;
  preboardingUrl: string;
}

interface WelcomeJobData {
  employeeId: string;
  email: string;
  phone: string;
  firstName: string;
  empCode: string;
  loginUrl: string;
}

interface PasswordResetJobData {
  userId: string;
  email: string;
  firstName: string;
  resetLink: string;
}

interface PasswordResetConfirmationJobData {
  email: string;
  firstName: string;
}

function onboardingInviteHtml(
  firstName: string,
  empCode: string,
  tempPassword: string,
  email: string,
  preboardingUrl: string,
): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Welcome, ${firstName}! Your employee account is ready.</h2>
      <p>Your account has been created. Please use the credentials below to log in and complete your profile.</p>
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
        <tr>
          <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold; border: 1px solid #ddd;">Employee Code</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd;">${empCode}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold; border: 1px solid #ddd;">Login Email</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd;">${email}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold; border: 1px solid #ddd;">Temporary Password</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd;">${tempPassword}</td>
        </tr>
      </table>
      <p>⚠️ You will be required to change this password on first login.</p>
      <p>Please also complete your onboarding details at:</p>
      <p><a href="${preboardingUrl}" style="color: #1a73e8;">${preboardingUrl}</a></p>
      <p style="color: #666; font-size: 13px;">If you did not expect this email, please contact HR immediately.</p>
    </div>
  `;
}

function welcomeHtml(firstName: string, empCode: string, loginUrl: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>🎉 Welcome to the team, ${firstName}!</h2>
      <p>Your account is now active. You can log in to the HRMS portal using the link below.</p>
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
        <tr>
          <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold; border: 1px solid #ddd;">Employee Code</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd;">${empCode}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; background: #f5f5f5; font-weight: bold; border: 1px solid #ddd;">Login Portal</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd;"><a href="${loginUrl}">${loginUrl}</a></td>
        </tr>
      </table>
      <p>If you have any questions, please reach out to the HR team.</p>
    </div>
  `;
}

function passwordResetHtml(firstName: string, resetLink: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Password Reset Request</h2>
      <p>Hi ${firstName},</p>
      <p>An administrator has initiated a password reset for your HRMS account. Click the link below to set a new password:</p>
      <p style="margin: 24px 0;">
        <a href="${resetLink}" style="background: #1a73e8; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Reset Password</a>
      </p>
      <p>Or copy this link into your browser:</p>
      <p style="color: #1a73e8; word-break: break-all;">${resetLink}</p>
      <p style="color: #e53935; font-size: 13px;">⚠️ This link expires in 24 hours.</p>
      <p style="color: #666; font-size: 13px;">If you did not request a password reset, please contact HR immediately.</p>
    </div>
  `;
}

function passwordChangedHtml(firstName: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Password Changed Successfully</h2>
      <p>Hi ${firstName},</p>
      <p>Your HRMS account password has been changed successfully.</p>
      <p>If you did not make this change, please contact HR immediately to secure your account.</p>
    </div>
  `;
}

@Processor('employees')
export class EmployeesProcessor extends WorkerHost {
  private readonly logger = new Logger(EmployeesProcessor.name);

  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'employee.onboarding-invite':
        await this.handleOnboardingInvite(job.data as OnboardingInviteJobData);
        break;
      case 'employee.welcome':
        await this.handleWelcome(job.data as WelcomeJobData);
        break;
      case 'employee.password-reset':
        await this.handlePasswordReset(job.data as PasswordResetJobData);
        break;
      case 'employee.password-reset-confirmation':
        await this.handlePasswordResetConfirmation(job.data as PasswordResetConfirmationJobData);
        break;
      default:
        this.logger.warn(`Unknown job: ${job.name}`);
    }
  }

  private async handleOnboardingInvite(data: OnboardingInviteJobData) {
    const html = onboardingInviteHtml(
      data.firstName,
      data.empCode,
      data.tempPassword,
      data.email,
      data.preboardingUrl,
    );
    await Promise.allSettled([
      this.notifications.sendEmail(data.email, 'Welcome — Complete Your Onboarding', html),
      this.notifications.sendSms(data.phone, 'employeeInvite', {
        empCode: data.empCode,
        email: data.email,
        tempPassword: data.tempPassword,
      }),
    ]);
    this.logger.log(`Onboarding invite sent for employee ${data.employeeId}`);
  }

  private async handleWelcome(data: WelcomeJobData) {
    const html = welcomeHtml(data.firstName, data.empCode, data.loginUrl);
    await Promise.allSettled([
      this.notifications.sendEmail(
        data.email,
        'Welcome to the Team — Your Account is Active',
        html,
      ),
      this.notifications.sendSms(data.phone, 'employeeWelcome', {
        firstName: data.firstName,
        empCode: data.empCode,
        loginUrl: data.loginUrl,
      }),
    ]);
    this.logger.log(`Welcome email sent for employee ${data.employeeId}`);
  }

  private async handlePasswordReset(data: PasswordResetJobData) {
    const html = passwordResetHtml(data.firstName, data.resetLink);
    await this.notifications.sendEmail(data.email, 'Reset Your HRMS Password', html);
    this.logger.log(`Password reset email sent to user ${data.userId}`);
  }

  private async handlePasswordResetConfirmation(data: PasswordResetConfirmationJobData) {
    const html = passwordChangedHtml(data.firstName);
    await this.notifications.sendEmail(data.email, 'HRMS Password Changed', html);
    this.logger.log(`Password change confirmation sent to ${data.email}`);
  }
}
