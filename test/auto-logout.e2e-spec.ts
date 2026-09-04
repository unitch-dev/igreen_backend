import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { AutoLogoutScheduler } from '../src/modules/organizations/auto-logout.scheduler';

/**
 * Dynamic per-organization auto-logout (see
 * docs/modules/auto-logout-and-mobile-validation.md, Feature 1):
 *  - PUT /organization (org:update) accepts autoLogoutEnabled/Time/Timezone,
 *    validates HH:mm format, IANA timezone, and the "enabled requires time"
 *    cross-field rule.
 *  - GET /organization (org:read) echoes the three fields back.
 *  - POST /auth/login and GET /auth/me surface user.autoLogout for every
 *    authenticated user (including one without org:read).
 *  - AutoLogoutScheduler revokes refresh tokens + closes login history once
 *    an org's local time reaches its cutoff, and does not refire the same
 *    calendar day (idempotency key).
 *  - Manual logout is unaffected.
 */
describe('Dynamic auto-logout (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let scheduler: AutoLogoutScheduler;

  const PASSWORD = 'Test@1234';
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    scheduler = app.get(AutoLogoutScheduler);
  });

  afterAll(async () => {
    for (const organizationId of createdOrgIds) {
      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.loginHistory.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await app.close();
  });

  interface OrgFixture {
    organizationId: string;
    adminToken: string; // org:read + org:update
    employeeToken: string; // no org permissions at all
    employeeId: string;
    employeeEmail: string;
    adminId: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `autologout-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `AutoLogout E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const adminRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `al-e2e-admin-${label}`,
        description: 'org:read + org:update',
        permissions: ['org:read', 'org:update'],
        isSystemRole: false,
      },
    });

    const employeeRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `al-e2e-employee-${label}`,
        description: 'No org permissions',
        permissions: ['leave:apply'],
        isSystemRole: false,
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const adminUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `admin-${label}@al-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: adminUser.id, roleId: adminRole.id } });

    const employeeUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `employee-${label}@al-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: employeeUser.id, roleId: employeeRole.id } });

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: PASSWORD })
      .expect(200);

    const employeeLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: employeeUser.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      adminToken: adminLogin.body.data.accessToken,
      employeeToken: employeeLogin.body.data.accessToken,
      employeeId: employeeUser.id,
      employeeEmail: employeeUser.email,
      adminId: adminUser.id,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  describe('PUT /organization — validation', () => {
    it('400s when autoLogoutEnabled=true with no autoLogoutTime', async () => {
      const org = await createOrgFixture('enable-no-time');
      const res = await request(app.getHttpServer())
        .put('/api/v1/organization')
        .set(authed(org.adminToken, org.organizationId))
        .send({ autoLogoutEnabled: true })
        .expect(400);
      expect(res.body.message).toMatch(/autoLogoutTime is required/i);
    });

    it('400s on a bad time format', async () => {
      const org = await createOrgFixture('bad-time');
      await request(app.getHttpServer())
        .put('/api/v1/organization')
        .set(authed(org.adminToken, org.organizationId))
        .send({ autoLogoutEnabled: true, autoLogoutTime: '25:99' })
        .expect(400);

      await request(app.getHttpServer())
        .put('/api/v1/organization')
        .set(authed(org.adminToken, org.organizationId))
        .send({ autoLogoutEnabled: true, autoLogoutTime: '9:30pm' })
        .expect(400);
    });

    it('400s on a bad timezone', async () => {
      const org = await createOrgFixture('bad-tz');
      await request(app.getHttpServer())
        .put('/api/v1/organization')
        .set(authed(org.adminToken, org.organizationId))
        .send({ autoLogoutTimezone: 'Not/A_Real_Zone' })
        .expect(400);
    });

    it('accepts the IANA alias "Asia/Kolkata" (not just its canonical name "Asia/Calcutta")', async () => {
      // Regression test — see docs/known-issues.md: Intl.supportedValuesOf('timeZone')
      // only lists CANONICAL zone names and previously caused a false 400 on
      // this exact, extremely common value.
      const org = await createOrgFixture('tz-alias');
      await request(app.getHttpServer())
        .put('/api/v1/organization')
        .set(authed(org.adminToken, org.organizationId))
        .send({ autoLogoutTimezone: 'Asia/Kolkata' })
        .expect(200);
    });

    it('200s and persists valid values, echoed on GET /organization', async () => {
      const org = await createOrgFixture('happy-path');
      const putRes = await request(app.getHttpServer())
        .put('/api/v1/organization')
        .set(authed(org.adminToken, org.organizationId))
        .send({
          autoLogoutEnabled: true,
          autoLogoutTime: '21:30',
          autoLogoutTimezone: 'America/New_York',
        })
        .expect(200);

      expect(putRes.body.data.autoLogoutEnabled).toBe(true);
      expect(putRes.body.data.autoLogoutTime).toBe('21:30');
      expect(putRes.body.data.autoLogoutTimezone).toBe('America/New_York');

      const getRes = await request(app.getHttpServer())
        .get('/api/v1/organization')
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      expect(getRes.body.data.autoLogoutEnabled).toBe(true);
      expect(getRes.body.data.autoLogoutTime).toBe('21:30');
      expect(getRes.body.data.autoLogoutTimezone).toBe('America/New_York');
    });

    it('403s a user without org:update', async () => {
      const org = await createOrgFixture('no-update-perm');
      await request(app.getHttpServer())
        .put('/api/v1/organization')
        .set(authed(org.employeeToken, org.organizationId))
        .send({ autoLogoutEnabled: true, autoLogoutTime: '21:30' })
        .expect(403);
    });
  });

  describe('Auth responses expose autoLogout to every authenticated user', () => {
    it('login + /auth/me return user.autoLogout even for a user with NO org:read', async () => {
      const org = await createOrgFixture('auth-surface');
      // Regression check: `Asia/Kolkata` is a valid IANA alias (not the
      // canonical `Asia/Calcutta`) and is the org default used everywhere
      // else in this codebase — it must be accepted, not 400'd (see
      // docs/known-issues.md).
      await request(app.getHttpServer())
        .put('/api/v1/organization')
        .set(authed(org.adminToken, org.organizationId))
        .send({
          autoLogoutEnabled: true,
          autoLogoutTime: '18:00',
          autoLogoutTimezone: 'Asia/Kolkata',
        })
        .expect(200);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: org.employeeEmail, password: PASSWORD })
        .expect(200);
      expect(login.body.data.user.autoLogout).toEqual({
        enabled: true,
        time: '18:00',
        timezone: 'Asia/Kolkata',
      });

      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(authed(org.employeeToken, org.organizationId))
        .expect(200);
      expect(me.body.data.autoLogout).toEqual({
        enabled: true,
        time: '18:00',
        timezone: 'Asia/Kolkata',
      });
    });

    it('defaults to disabled/null-time/Asia-Kolkata when never configured', async () => {
      const org = await createOrgFixture('auth-default');
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: org.employeeEmail, password: PASSWORD })
        .expect(200);
      expect(login.body.data.user.autoLogout).toEqual({
        enabled: false,
        time: null,
        timezone: 'Asia/Kolkata',
      });
    });
  });

  describe('AutoLogoutScheduler', () => {
    function currentLocalHHmm(timezone: string): string {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date());
    }

    it('revokes refresh tokens + closes login history once cutoff is reached, and does not refire same day', async () => {
      const org = await createOrgFixture('scheduler-fire');
      const timezone = 'Asia/Kolkata';
      const cutoff = currentLocalHHmm(timezone);

      await prisma.organization.update({
        where: { id: org.organizationId },
        data: { autoLogoutEnabled: true, autoLogoutTime: cutoff, autoLogoutTimezone: timezone },
      });

      // Sanity: refresh token exists and refresh works before cutoff fires.
      const beforeRefresh = await redis.get(`refresh:${org.employeeId}`);
      expect(beforeRefresh).toBeTruthy();

      await scheduler.enforceAutoLogout();

      const afterRefresh = await redis.get(`refresh:${org.employeeId}`);
      expect(afterRefresh).toBeNull();

      // A subsequent /auth/refresh with the old token must now be rejected.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: beforeRefresh })
        .expect(401);

      // Open login-history row should have been closed.
      const history = await prisma.loginHistory.findFirst({
        where: { userId: org.employeeId },
        orderBy: { loginAt: 'desc' },
      });
      expect(history?.logoutAt).not.toBeNull();

      // Idempotency: log the employee back in (new refresh token), run the
      // scheduler again the same minute/day — must NOT re-revoke.
      const relogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: org.employeeEmail, password: PASSWORD })
        .expect(200);
      const newRefreshToken = relogin.body.data.refreshToken;

      await scheduler.enforceAutoLogout();

      const stillThere = await redis.get(`refresh:${org.employeeId}`);
      expect(stillThere).toBe(newRefreshToken);
    });

    it('does not fire for an org whose cutoff has not been reached yet', async () => {
      const org = await createOrgFixture('scheduler-no-fire');
      // Pick a cutoff far in the future relative to any timezone "now".
      await prisma.organization.update({
        where: { id: org.organizationId },
        data: {
          autoLogoutEnabled: true,
          autoLogoutTime: '23:59',
          autoLogoutTimezone: 'Pacific/Kiritimati',
        },
      });

      const before = await redis.get(`refresh:${org.employeeId}`);
      expect(before).toBeTruthy();

      await scheduler.enforceAutoLogout();

      const after = await redis.get(`refresh:${org.employeeId}`);
      // Not guaranteed to still equal `before` in a flaky way only if the
      // real UTC clock happens to land on 23:59 in that zone; astronomically
      // unlikely for a CI run, so a plain existence check is deterministic
      // enough here.
      expect(after).toBeTruthy();
    });
  });

  describe('Manual logout is unaffected by auto-logout scheduler', () => {
    it('POST /auth/logout still revokes only the calling session, independent of cron state', async () => {
      const org = await createOrgFixture('manual-logout');
      const refreshBefore = await redis.get(`refresh:${org.employeeId}`);
      expect(refreshBefore).toBeTruthy();

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(authed(org.employeeToken, org.organizationId))
        .expect(200);

      const refreshAfter = await redis.get(`refresh:${org.employeeId}`);
      expect(refreshAfter).toBeNull();
    });
  });
});
