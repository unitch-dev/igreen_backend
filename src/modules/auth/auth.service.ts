import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { totp } from 'otplib';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {
    totp.options = { step: 300, digits: 6 };
  }

  // ── Validate password (used by LocalStrategy) ────────────────────────────

  async validatePassword(email: string, password: string) {
    const lockKey = `lockout:${email}`;
    const failKey = `failed:${email}`;

    const locked = await this.redis.exists(lockKey);
    if (locked) {
      throw new HttpException(
        'Account temporarily locked due to too many failed attempts. Try again in 15 minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // IMPORTANT: must `include: { employee: true }` (used as a fallback — see
    // `auth.controller.ts`'s `login()`, which now derives the JWT's
    // `organizationId` claim primarily from `req.user.organizationId`, the
    // User row's own always-populated column, falling back to
    // `req.user.employee?.organizationId` only if that were ever absent).
    // Without this include, the fallback would silently resolve to `undefined`
    // for the small number of callers that still rely on it. If you add a new
    // JWT-issuing path here, always select `employee` too, and always prefer
    // `user.organizationId` over `user.employee?.organizationId` as the primary
    // source — the latter is `null` for any user with no linked Employee row
    // (e.g. the seeded super_admin account), which previously broke every
    // `@CurrentUser('organizationId')`-scoped endpoint for that account.
    //
    // CRITICAL: `User.email` is unique only PER ORGANIZATION
    // (`@@unique([organizationId, email])`), by design — the same email may
    // legitimately exist in two different orgs (two separate tenants each
    // onboarding an employee with the same address). `LoginDto` has no
    // organizationId field (the frontend cannot know the org before it
    // authenticates), so this lookup can return MULTIPLE rows across
    // different orgs. Using `findFirst` here previously picked an arbitrary
    // one (DB engine/index order) and compared the submitted password against
    // ONLY that row — so a real, correctly-passworded user in org B could get
    // a false "Invalid email or password" (or, worse, a *different* org's
    // stale/matching row could authenticate) whenever an email collided
    // across orgs, entirely nondeterministic and silent. Fixed: fetch ALL
    // matching rows and bcrypt-compare against each until one matches, so the
    // correct tenant's user always wins regardless of row order. True
    // ambiguity (same email AND same password hash match in two orgs) is a
    // residual, inherent limit of email+password-only login with no org
    // selector — out of scope here, flagged in known-issues.md.
    const candidates = await this.prisma.user.findMany({
      where: { email, isActive: true },
      include: { employee: { select: { organizationId: true } } },
    });

    if (candidates.length === 0) {
      await this.redis.incr(failKey, 15 * 60);
      return null;
    }

    let user: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(password, candidate.passwordHash)) {
        user = candidate;
        break;
      }
    }

    if (!user) {
      const attempts = await this.redis.incr(failKey, 15 * 60);
      if (attempts >= 5) {
        await this.redis.set(lockKey, '1', 15 * 60);
      }
      return null;
    }

    await Promise.all([this.redis.del(failKey), this.redis.del(lockKey)]);
    return user;
  }

  // ── Password login ────────────────────────────────────────────────────────

  async login(userId: string, organizationId: string, ipAddress?: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: { include: { role: true } },
        employee: {
          include: { department: true, designation: true },
        },
      },
    });

    if (!user) throw new UnauthorizedException('User not found');

    // Lightweight, non-sensitive branding metadata every authenticated user
    // needs regardless of `org:read` — see tenant-logo-branding module plan.
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, logoUrl: true },
    });

    const tokens = await this.generateTokens(user.id, user.email, organizationId);

    // Save refresh token & login history in parallel
    await Promise.all([
      this.redis.saveRefreshToken(user.id, tokens.refreshToken, 30 * 24 * 60 * 60),
      this.prisma.loginHistory.create({
        data: {
          userId: user.id,
          ipAddress,
          userAgent,
          status: 'success',
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
    ]);

    const permissions = user.userRoles.flatMap((ur) => (ur.role.permissions as string[]) || []);

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        organizationId,
        organizationName: org?.name ?? null,
        organizationLogoUrl: org?.logoUrl ?? null,
        mustChangePassword: user.mustChangePassword,
        permissions: [...new Set(permissions)],
        employee: user.employee
          ? {
              id: user.employee.id,
              empCode: user.employee.empCode,
              firstName: user.employee.firstName,
              lastName: user.employee.lastName,
              department: user.employee.department?.name ?? null,
              designation: user.employee.designation?.name ?? null,
              status: user.employee.status,
              profilePhotoUrl: user.employee.profilePhotoUrl ?? null,
            }
          : null,
      },
    };
  }

  // ── OTP: send ─────────────────────────────────────────────────────────────

  async sendOtp(
    phone: string,
  ): Promise<{ sent: boolean; message: string; validForSeconds: number }> {
    const user = await this.prisma.user.findFirst({
      where: { phone, isActive: true },
    });
    if (!user) throw new NotFoundException('No active account found for this phone number');

    const secret = `${phone}${this.config.get('jwt.secret')}`;
    const otp = totp.generate(secret);

    await this.redis.saveOtp(phone, otp, 300);

    // In production, dispatch via SMSHorizon. Logged to console in dev.
    if (this.config.get('nodeEnv') !== 'production') {
      console.log(`[DEV OTP] Phone: ${phone} → OTP: ${otp}`);
    } else {
      await this.notifications.sendSms(phone, 'otp', { otp });
    }

    return {
      sent: true,
      message: `OTP sent successfully to +91 ${phone.slice(0, 2)}XXXXXX${phone.slice(-2)}`,
      validForSeconds: 300,
    };
  }

  // ── OTP: verify ───────────────────────────────────────────────────────────

  async verifyOtp(phone: string, otp: string, ipAddress?: string, userAgent?: string) {
    const storedOtp = await this.redis.getOtp(phone);
    if (!storedOtp || storedOtp !== otp) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    const user = await this.prisma.user.findFirst({
      where: { phone, isActive: true },
      include: {
        userRoles: { include: { role: true } },
        employee: {
          include: { department: true, designation: true },
        },
      },
    });
    if (!user) throw new UnauthorizedException('Account not found');

    await this.redis.deleteOtp(phone);

    // Same fix as `AuthController.login()` — prefer `user.organizationId`
    // (the User row's own always-populated column) over
    // `user.employee?.organizationId`, which is `null` for any user with no
    // linked Employee row. See known-issues.md.
    const organizationId = user.organizationId ?? user.employee?.organizationId ?? '';
    return this.login(user.id, organizationId, ipAddress, userAgent);
  }

  // ── Refresh token ─────────────────────────────────────────────────────────

  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get('jwt.secret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const stored = await this.redis.getRefreshToken(payload.sub);
    if (!stored || stored !== refreshToken) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    const tokens = await this.generateTokens(payload.sub, payload.email, payload.organizationId);
    await this.redis.saveRefreshToken(payload.sub, tokens.refreshToken, 30 * 24 * 60 * 60);

    return tokens;
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async logout(userId: string) {
    await Promise.all([
      this.redis.deleteRefreshToken(userId),
      this.prisma.loginHistory.updateMany({
        where: { userId, logoutAt: null },
        data: { logoutAt: new Date() },
      }),
    ]);
    return { success: true, message: 'Logged out successfully' };
  }

  // ── Current user ──────────────────────────────────────────────────────────

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: { include: { role: true } },
        employee: {
          include: { department: true, designation: true },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    // Lightweight, non-sensitive branding metadata every authenticated user
    // needs regardless of `org:read` — see tenant-logo-branding module plan.
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { name: true, logoUrl: true },
    });

    const permissions = user.userRoles.flatMap((ur) => (ur.role.permissions as string[]) || []);
    // `roles` is part of the documented `AuthUserDto` shape and the frontend's
    // `AuthUser` type (`ProfilePage.tsx` reads `user.roles[0]?.name`) — it was
    // previously omitted from this response entirely, which crashed the whole
    // Profile page for EVERY user (not just employee-less accounts) with
    // "Cannot read properties of undefined (reading '0')". Always include it.
    const roles = user.userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name }));

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      // `User.organizationId` is the source of truth (see auth.controller.ts
      // `login()` and known-issues.md) — do NOT derive from
      // `user.employee?.organizationId`, which is `null` for any user with no
      // linked Employee row (e.g. the seeded super_admin account).
      organizationId: user.organizationId,
      organizationName: org?.name ?? null,
      organizationLogoUrl: org?.logoUrl ?? null,
      mustChangePassword: user.mustChangePassword,
      permissions: [...new Set(permissions)],
      roles,
      employee: user.employee
        ? {
            id: user.employee.id,
            empCode: user.employee.empCode,
            firstName: user.employee.firstName,
            lastName: user.employee.lastName,
            department: user.employee.department?.name ?? null,
            designation: user.employee.designation?.name ?? null,
            profilePhotoUrl: user.employee.profilePhotoUrl ?? null,
          }
        : null,
    };
  }

  // ── Change password ───────────────────────────────────────────────────────

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: { select: { firstName: true } } },
    });
    if (!user) throw new NotFoundException('User not found');

    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
    await this.redis.deleteRefreshToken(userId);

    this.sendPasswordChangedEmail(user.email, user.employee?.firstName ?? 'there').catch(() => {});

    return { changed: true, message: 'Password changed successfully. Please log in again.' };
  }

  // ── Reset password via admin-issued token ─────────────────────────────────

  async resetPassword(token: string, newPassword: string) {
    const userId = await this.redis.get(`pwd-reset:${token}`);
    if (!userId) throw new BadRequestException('Password reset link is invalid or has expired');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: { select: { firstName: true } } },
    });
    if (!user) throw new NotFoundException('User account not found');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await Promise.all([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.redis.del(`pwd-reset:${token}`),
      this.redis.deleteRefreshToken(userId),
    ]);

    this.sendPasswordChangedEmail(user.email, user.employee?.firstName ?? 'there').catch(() => {});

    return {
      reset: true,
      message: 'Password reset successfully. You can now log in with your new password.',
    };
  }

  // ── Session management ────────────────────────────────────────────────────

  async getSessions(userId: string) {
    return this.prisma.loginHistory.findMany({
      where: { userId, logoutAt: null },
      orderBy: { loginAt: 'desc' },
      select: { id: true, ipAddress: true, userAgent: true, loginAt: true },
    });
  }

  async logoutAll(userId: string) {
    await Promise.all([
      this.redis.deleteRefreshToken(userId),
      this.prisma.loginHistory.updateMany({
        where: { userId, logoutAt: null },
        data: { logoutAt: new Date() },
      }),
    ]);
    return { success: true, message: 'Logged out from all devices' };
  }

  async logoutSession(userId: string, sessionId: string) {
    const session = await this.prisma.loginHistory.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw new NotFoundException('Session not found');

    await this.prisma.loginHistory.update({
      where: { id: sessionId },
      data: { logoutAt: new Date() },
    });
    return { success: true, message: 'Session terminated' };
  }

  // ── Register device token (FCM) ───────────────────────────────────────────

  async registerDeviceToken(userId: string, token: string, platform: string) {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
    return { registered: true, message: 'Device token registered for push notifications' };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async generateTokens(userId: string, email: string, organizationId: string) {
    const payload = { sub: userId, email, organizationId };
    const expiresIn = this.config.get<string>('jwt.accessExpiresIn');

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, { expiresIn }),
      this.jwt.signAsync(payload, { expiresIn: this.config.get('jwt.refreshExpiresIn') }),
    ]);

    return { accessToken, refreshToken, expiresIn };
  }

  private async sendPasswordChangedEmail(email: string, firstName: string) {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Changed Successfully</h2>
        <p>Hi ${firstName},</p>
        <p>Your HRMS account password has been changed successfully.</p>
        <p>If you did not make this change, please contact HR immediately to secure your account.</p>
      </div>
    `;
    await this.notifications.sendEmail(email, 'HRMS Password Changed', html);
  }
}
