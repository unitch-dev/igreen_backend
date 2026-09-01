import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * PrismaService audit-logging middleware coverage:
 *
 *  - POSITIVE: a mutation on an audited model (Department, in AUDITED_MODELS)
 *    produces an AuditLog row, and that row surfaces through
 *    GET /reports/audit as a `systemChanges` entry with correct
 *    entityType/action/actorName.
 *  - NEGATIVE: a mutation on a model NOT in AUDITED_MODELS (LoginHistory)
 *    does not create any AuditLog row.
 *  - RESILIENCE: if the best-effort AuditLog insert itself fails, the
 *    original business write must still succeed (see prisma.service.ts
 *    comment: "Never let this throw back into the caller").
 *
 * Runs against the real dev MySQL/Redis instance (same as `npm run start:dev`).
 */
describe('Audit logging middleware (e2e)', () => {
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
      await prisma.auditLog.deleteMany({ where: { organizationId } });
      await prisma.department.deleteMany({ where: { organizationId } });
      await prisma.loginHistory.deleteMany({ where: { user: { organizationId } } });
      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await app.close();
  });

  interface OrgFixture {
    organizationId: string;
    adminToken: string;
    adminUserId: string;
    adminEmail: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `audit-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Audit E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const role = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `audit-e2e-admin-${label}`,
        description: 'employee:create/read/update + report:audit for audit-log e2e coverage',
        permissions: ['employee:create', 'employee:read', 'employee:update', 'report:audit'],
        isSystemRole: false,
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const email = `admin-${label}-${uuid()}@audit-e2e.test`;
    const user = await prisma.user.create({
      data: { organizationId: org.id, email, passwordHash, isActive: true },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      adminToken: login.body.data.accessToken,
      adminUserId: user.id,
      adminEmail: email,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  /**
   * The AuditLog insert in PrismaService's middleware is deliberately
   * fire-and-forget (never awaited, so a slow/failing audit write can never
   * block or fail the business transaction — see prisma.service.ts). That
   * means a caller that reads AuditLog immediately after the HTTP response
   * comes back can race the still-in-flight insert. Poll briefly instead of
   * asserting instantly.
   */
  async function waitForAuditLog(where: Record<string, unknown>, attempts = 20, delayMs = 50) {
    for (let i = 0; i < attempts; i += 1) {
      const row = await prisma.auditLog.findFirst({ where });
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
  }

  // ─── POSITIVE ─────────────────────────────────────────────────────────────

  describe('POSITIVE: audited-model mutation produces a systemChanges entry', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('positive');
    });

    it('POST /departments creates an AuditLog row with correct action/entityType/actorId', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/departments')
        .set(authed(org.adminToken, org.organizationId))
        .send({ name: `Engineering-${uuid()}` })
        .expect(201);

      const departmentId = res.body.data.id;

      const auditRow = await waitForAuditLog({
        organizationId: org.organizationId,
        entityType: 'Department',
        entityId: departmentId,
      });

      expect(auditRow).not.toBeNull();
      expect(auditRow?.action).toBe('CREATE');
      expect(auditRow?.actorId).toBe(org.adminUserId);
    });

    it('GET /reports/audit surfaces the change as a systemChanges entry with actorName resolved', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/departments')
        .set(authed(org.adminToken, org.organizationId))
        .send({ name: `Ops-${uuid()}` })
        .expect(201);
      const departmentId = createRes.body.data.id;
      await waitForAuditLog({
        organizationId: org.organizationId,
        entityType: 'Department',
        entityId: departmentId,
      });

      const from = new Date(Date.now() - 60_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();

      const reportRes = await request(app.getHttpServer())
        .get('/api/v1/reports/audit')
        .query({ from, to })
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      const entries: any[] = reportRes.body.data.systemChanges;
      const match = entries.find((e) => e.entityId === departmentId);

      expect(match).toBeDefined();
      expect(match.entityType).toBe('Department');
      expect(match.action).toBe('CREATE');
      // No employee profile exists for this admin user, so actorName falls back
      // to the account email per reports.service.ts actorMap convention.
      expect(match.actorName).toBe(org.adminEmail);
    });
  });

  // ─── NEGATIVE ─────────────────────────────────────────────────────────────

  describe('NEGATIVE: non-audited model mutation does not create an AuditLog row', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('negative');
    });

    it('creating a LoginHistory row (via login) does not produce an AuditLog entry', async () => {
      const beforeCount = await prisma.auditLog.count({
        where: { organizationId: org.organizationId, entityType: 'LoginHistory' },
      });

      // A fresh login writes a new LoginHistory row for this user.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: org.adminEmail, password: PASSWORD })
        .expect(200);

      const loginHistoryRows = await prisma.loginHistory.count({ where: { userId: org.adminUserId } });
      expect(loginHistoryRows).toBeGreaterThan(0);

      const afterCount = await prisma.auditLog.count({
        where: { organizationId: org.organizationId, entityType: 'LoginHistory' },
      });

      expect(afterCount).toBe(beforeCount);
      expect(afterCount).toBe(0);
    });
  });

  // ─── RESILIENCE ───────────────────────────────────────────────────────────

  describe('RESILIENCE: business write survives an audit-insert failure', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('resilience');
    });

    it('POST /departments still returns 201 and persists the row when AuditLog.create rejects', async () => {
      const auditLogCreateSpy = jest
        .spyOn(prisma.auditLog, 'create')
        .mockRejectedValueOnce(new Error('simulated audit-log write failure'));

      const departmentName = `Resilient-${uuid()}`;
      const res = await request(app.getHttpServer())
        .post('/api/v1/departments')
        .set(authed(org.adminToken, org.organizationId))
        .send({ name: departmentName })
        .expect(201);

      expect(res.body.data.name).toBe(departmentName);

      const persisted = await prisma.department.findUnique({ where: { id: res.body.data.id } });
      expect(persisted).not.toBeNull();
      expect(persisted?.name).toBe(departmentName);

      auditLogCreateSpy.mockRestore();
    });
  });
});
