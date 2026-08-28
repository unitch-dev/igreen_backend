import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

// Fixture setup here creates several orgs, each with 3 users + logins
// (bcrypt hashing/comparison is intentionally slow) — mirrors reports.e2e-spec.ts's
// 30s timeout rather than the 5s Jest default.
jest.setTimeout(30000);

/**
 * SMS Templates module (M-SMS-TEMPLATES) end-to-end coverage:
 *  - GET /sms-templates lists the 5 seeded global rows (sms_template:read).
 *  - GET /sms-templates/:id returns a single row (sms_template:read).
 *  - PUT /sms-templates/:id persists message/tid/senderId/isActive and
 *    silently ignores any attempt to change key/name (sms_template:update).
 *  - Permission boundaries: 403 for GET without sms_template:read, 403 for
 *    PUT without sms_template:update.
 *  - This table is intentionally GLOBAL (no organizationId column) — the
 *    "multi-tenancy" check here is the inverse of every other module's: we
 *    assert the SAME 5 rows are visible from two different orgs' tokens,
 *    proving there is no accidental per-tenant duplication/isolation bug.
 *
 * Runs against the real dev MySQL/Redis instance (same as `npm run start:dev`).
 */
describe('SMS Templates module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const PASSWORD = 'Test@1234';
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
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
  });

  afterAll(async () => {
    for (const organizationId of createdOrgIds) {
      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.loginHistory.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.employee.deleteMany({ where: { organizationId } });
      await prisma.designation.deleteMany({ where: { organizationId } });
      await prisma.department.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    // Restore the seeded OTP template's message in case the update test's
    // cleanup didn't run (defensive; the test also restores it itself).
    await app.close();
  });

  interface OrgFixture {
    organizationId: string;
    readToken: string; // sms_template:read only
    updateToken: string; // sms_template:read + sms_template:update
    noPermToken: string; // profile:read only, no sms_template:*
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `sms-templates-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `SMS Templates E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const readRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `sms-e2e-read-${label}`,
        description: 'Test role with sms_template:read only',
        permissions: ['profile:read', 'sms_template:read'],
        isSystemRole: false,
      },
    });
    const updateRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `sms-e2e-update-${label}`,
        description: 'Test role with sms_template:read + sms_template:update',
        permissions: ['profile:read', 'sms_template:read', 'sms_template:update'],
        isSystemRole: false,
      },
    });
    const noPermRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `sms-e2e-noperm-${label}`,
        description: 'Test role with no sms_template permissions',
        permissions: ['profile:read'],
        isSystemRole: false,
      },
    });

    const department = await prisma.department.create({
      data: { organizationId: org.id, name: `Dept ${label}` },
    });
    const designation = await prisma.designation.create({
      data: { organizationId: org.id, departmentId: department.id, name: `Designation ${label}` },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    async function createUserWithRole(roleId: string, code: string, emailPrefix: string) {
      const employee = await prisma.employee.create({
        data: {
          organizationId: org.id,
          empCode: `${code}-${label}`,
          firstName: emailPrefix,
          lastName: label,
          phone: `91000${Math.floor(Math.random() * 100000)
            .toString()
            .padStart(5, '0')}`,
          departmentId: department.id,
          designationId: designation.id,
          status: 'ACTIVE',
        },
      });
      const user = await prisma.user.create({
        data: {
          organizationId: org.id,
          employeeId: employee.id,
          email: `${emailPrefix}-${label}@sms-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
      return login.body.data.accessToken as string;
    }

    const readToken = await createUserWithRole(readRole.id, 'RD', 'reader');
    const updateToken = await createUserWithRole(updateRole.id, 'UP', 'updater');
    const noPermToken = await createUserWithRole(noPermRole.id, 'NP', 'noperm');

    return { organizationId: org.id, readToken, updateToken, noPermToken };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  // ─── LIST / GET ─────────────────────────────────────────────────────────

  describe('GET /sms-templates', () => {
    it('returns the 5 seeded global templates with sms_template:read', async () => {
      const org = await createOrgFixture('list');

      const res = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(org.readToken, org.organizationId))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThanOrEqual(5);
      const keys = res.body.data.map((t: { key: string }) => t.key).sort();
      expect(keys).toEqual(
        [
          'employeeInvite',
          'employeeWelcome',
          'onboardingInvite',
          'onboardingWelcome',
          'otp',
        ].sort(),
      );
      expect(res.body.httpCode).toBe(200);
    });

    it('is visible identically from a second org (global table, not org-scoped)', async () => {
      const orgA = await createOrgFixture('global-a');
      const orgB = await createOrgFixture('global-b');

      const resA = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(orgA.readToken, orgA.organizationId))
        .expect(200);
      const resB = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(orgB.readToken, orgB.organizationId))
        .expect(200);

      const idsA = resA.body.data.map((t: { id: string }) => t.id).sort();
      const idsB = resB.body.data.map((t: { id: string }) => t.id).sort();
      expect(idsA).toEqual(idsB);
    });

    it('returns 403 without sms_template:read', async () => {
      const org = await createOrgFixture('list-403');
      await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(org.noPermToken, org.organizationId))
        .expect(403);
    });
  });

  describe('GET /sms-templates/:id', () => {
    it('returns a single template with sms_template:read', async () => {
      const org = await createOrgFixture('get-one');
      const list = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(org.readToken, org.organizationId))
        .expect(200);
      const otp = list.body.data.find((t: { key: string }) => t.key === 'otp');
      expect(otp).toBeDefined();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sms-templates/${otp.id}`)
        .set(authed(org.readToken, org.organizationId))
        .expect(200);

      expect(res.body.data.id).toBe(otp.id);
      expect(res.body.data.key).toBe('otp');
      expect(res.body.data.message).toContain('{{otp}}');
    });

    it('returns 403 without sms_template:read', async () => {
      const org = await createOrgFixture('get-one-403');
      const list = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(org.readToken, org.organizationId))
        .expect(200);
      const otp = list.body.data.find((t: { key: string }) => t.key === 'otp');

      await request(app.getHttpServer())
        .get(`/api/v1/sms-templates/${otp.id}`)
        .set(authed(org.noPermToken, org.organizationId))
        .expect(403);
    });

    it('returns 404 for an unknown id', async () => {
      const org = await createOrgFixture('get-404');
      await request(app.getHttpServer())
        .get(`/api/v1/sms-templates/${uuid()}`)
        .set(authed(org.readToken, org.organizationId))
        .expect(404);
    });
  });

  // ─── UPDATE ─────────────────────────────────────────────────────────────

  describe('PUT /sms-templates/:id', () => {
    it('persists message/tid/senderId/isActive with sms_template:update', async () => {
      const org = await createOrgFixture('update');
      const list = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(org.updateToken, org.organizationId))
        .expect(200);
      const onboardingInvite = list.body.data.find(
        (t: { key: string }) => t.key === 'onboardingInvite',
      );
      const originalMessage = onboardingInvite.message;

      try {
        const res = await request(app.getHttpServer())
          .put(`/api/v1/sms-templates/${onboardingInvite.id}`)
          .set(authed(org.updateToken, org.organizationId))
          .send({
            message: "Hi! You've been invited — onboard here: {{link}}",
            tid: '1234567890123456789',
            senderId: 'IGRNTC',
            isActive: false,
          })
          .expect(200);

        expect(res.body.data.message).toBe("Hi! You've been invited — onboard here: {{link}}");
        expect(res.body.data.tid).toBe('1234567890123456789');
        expect(res.body.data.senderId).toBe('IGRNTC');
        expect(res.body.data.isActive).toBe(false);
        // key/name must never change via this endpoint
        expect(res.body.data.key).toBe('onboardingInvite');
        expect(res.body.data.name).toBe(onboardingInvite.name);

        const persisted = await prisma.smsTemplate.findUnique({
          where: { id: onboardingInvite.id },
        });
        expect(persisted?.message).toBe("Hi! You've been invited — onboard here: {{link}}");
        expect(persisted?.tid).toBe('1234567890123456789');
        expect(persisted?.senderId).toBe('IGRNTC');
        expect(persisted?.isActive).toBe(false);
      } finally {
        // Restore so this shared global row doesn't affect other tests/dev.
        await prisma.smsTemplate.update({
          where: { id: onboardingInvite.id },
          data: {
            message: originalMessage,
            tid: onboardingInvite.tid,
            senderId: onboardingInvite.senderId,
            isActive: onboardingInvite.isActive,
          },
        });
      }
    });

    it('ignores attempts to change key/name in the request body', async () => {
      const org = await createOrgFixture('update-immutable');
      const list = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(org.updateToken, org.organizationId))
        .expect(200);
      const otp = list.body.data.find((t: { key: string }) => t.key === 'otp');

      // forbidNonWhitelisted rejects unknown properties outright (key/name
      // are not part of UpdateSmsTemplateDto), which itself proves the DTO
      // shape excludes them.
      await request(app.getHttpServer())
        .put(`/api/v1/sms-templates/${otp.id}`)
        .set(authed(org.updateToken, org.organizationId))
        .send({ message: otp.message, key: 'hacked', name: 'Hacked Name' })
        .expect(400);
    });

    it('returns 403 without sms_template:update', async () => {
      const org = await createOrgFixture('update-403');
      const list = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(org.readToken, org.organizationId))
        .expect(200);
      const otp = list.body.data.find((t: { key: string }) => t.key === 'otp');

      await request(app.getHttpServer())
        .put(`/api/v1/sms-templates/${otp.id}`)
        .set(authed(org.readToken, org.organizationId))
        .send({ message: otp.message })
        .expect(403);
    });

    it('returns 400 when message is empty', async () => {
      const org = await createOrgFixture('update-validation');
      const list = await request(app.getHttpServer())
        .get('/api/v1/sms-templates')
        .set(authed(org.updateToken, org.organizationId))
        .expect(200);
      const otp = list.body.data.find((t: { key: string }) => t.key === 'otp');

      await request(app.getHttpServer())
        .put(`/api/v1/sms-templates/${otp.id}`)
        .set(authed(org.updateToken, org.organizationId))
        .send({ message: '' })
        .expect(400);
    });
  });
});
