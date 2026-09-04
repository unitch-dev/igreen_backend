import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

const IDEMPOTENCY_TTL_SECONDS = 26 * 60 * 60; // ~26h — comfortably covers one calendar day

/**
 * Backend "real teeth" half of the auto-logout defense-in-depth pair (see
 * `useAutoLogout` on the frontend for the primary UX timer). Runs every
 * minute; for each org that has a configured cutoff, revokes the Redis
 * refresh token of every active user once the org's LOCAL wall-clock time
 * reaches (or has just passed) the cutoff, so a closed/backgrounded tab
 * cannot silently refresh its way past the cutoff.
 *
 * Idempotency: a Redis key `autologout:done:{orgId}:{localDate}` is set
 * after the first successful fire for a given org+local-calendar-day, so
 * this does not re-revoke (and re-generate DB writes) every minute for the
 * rest of the day once it has already fired.
 */
@Injectable()
export class AutoLogoutScheduler {
  private readonly logger = new Logger(AutoLogoutScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async enforceAutoLogout() {
    try {
      const orgs = await this.prisma.organization.findMany({
        where: { autoLogoutEnabled: true, autoLogoutTime: { not: null } },
        select: { id: true, autoLogoutTime: true, autoLogoutTimezone: true },
      });

      for (const org of orgs) {
        // eslint-disable-next-line no-await-in-loop
        await this.enforceForOrg(org.id, org.autoLogoutTime as string, org.autoLogoutTimezone);
      }
    } catch (error) {
      // Never let a cron failure crash the process or block the next tick.
      this.logger.error('Auto-logout enforcement pass failed', error as Error);
    }
  }

  private async enforceForOrg(orgId: string, cutoffTime: string, timezone: string) {
    let localTime: string;
    let localDate: string;
    try {
      const now = new Date();
      // en-CA formats as YYYY-MM-DD, which sorts/compares naturally and
      // gives us a clean idempotency-key date component.
      localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
      localTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(now);
    } catch (error) {
      this.logger.error(`Invalid timezone "${timezone}" for org ${orgId}`, error as Error);
      return;
    }

    if (localTime < cutoffTime) return; // cutoff not reached yet today

    const idempotencyKey = `autologout:done:${orgId}:${localDate}`;
    const alreadyFired = await this.redis.exists(idempotencyKey);
    if (alreadyFired) return;

    // Set the idempotency key BEFORE doing the work so a slow/overlapping
    // tick cannot double-fire; a failed fire will simply retry next day
    // rather than every minute (acceptable — see design decisions doc).
    await this.redis.set(idempotencyKey, '1', IDEMPOTENCY_TTL_SECONDS);

    try {
      const activeUsers = await this.prisma.user.findMany({
        where: { organizationId: orgId, isActive: true },
        select: { id: true },
      });
      if (activeUsers.length === 0) return;

      const userIds = activeUsers.map((u) => u.id);

      await Promise.all(userIds.map((userId) => this.redis.deleteRefreshToken(userId)));
      await this.prisma.loginHistory.updateMany({
        where: { userId: { in: userIds }, logoutAt: null },
        data: { logoutAt: new Date() },
      });

      this.logger.log(
        `Auto-logout fired for org ${orgId} at local time ${localTime} (cutoff ${cutoffTime}, tz ${timezone}) — revoked ${userIds.length} session(s)`,
      );
    } catch (error) {
      this.logger.error(`Auto-logout enforcement failed for org ${orgId}`, error as Error);
    }
  }
}
