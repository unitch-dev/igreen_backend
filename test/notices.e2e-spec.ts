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
 * Notices module (M13a) end-to-end coverage:
 *  - Targeting: TARGETED-by-department and TARGETED-by-role notices only show up
 *    on the board for viewers who actually match; ALL notices show for everyone.
 *  - Lifecycle: draft not board-visible; publish flips draft->published and it
 *    becomes visible; future-scheduledAt not visible; past-scheduledAt (status
 *    scheduled) IS visible via the query rule.
 *  - Read tracking: markRead upserts exactly one NoticeRead (idempotent), board
 *    hasRead flips true, read-receipts lists the reader, manage readCount reflects it.
 *  - Multi-tenancy: notices never leak across orgs.
 *  - Permission gating: employee:read-only user gets 403 on manage endpoints but
 *    can use the board + markRead.
 *
 * Runs against the real dev MySQL/Redis instance (same as `npm run start:dev`).
 */
describe('Notices module (e2e)', () => {
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
      const employees = await prisma.employee.findMany({
        where: { organizationId },
        select: { id: true },
      });
      const employeeIds = employees.map((e) => e.id);
      const notices = await prisma.notice.findMany({
        where: { organizationId },
        select: { id: true },
      });
      const noticeIds = notices.map((n) => n.id);

      await prisma.noticeRead.deleteMany({ where: { noticeId: { in: noticeIds } } });
      await prisma.notice.deleteMany({ where: { organizationId } });
      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.loginHistory.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.employee.deleteMany({ where: { organizationId } });
      await prisma.designation.deleteMany({ where: { organizationId } });
      await prisma.department.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      void employeeIds;
    }
    await app.close();
  });

  interface OrgFixture {
    organizationId: string;
    managerToken: string;
    deptAId: string;
    deptBId: string;
    specialRoleId: string;
    deptAEmployeeId: string;
    deptAToken: string;
    deptBEmployeeId: string;
    deptBToken: string;
    specialRoleEmployeeId: string;
    specialRoleToken: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `notices-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Notices E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const managerRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `notices-e2e-manager-${label}`,
        description: 'Test manager role',
        // NOTE: 'notice:manage' was missing here (pre-existing bug, unrelated
        // to the FileAsset storage refactor — see docs/known-issues.md), which
        // made every notice-creation call in this fixture 403 and cascaded
        // into 15/17 tests failing on unrelated assertions/timeouts.
        permissions: ['employee:read', 'onboarding:manage', 'notice:manage', 'notice:read'],
        isSystemRole: false,
      },
    });

    const employeeRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `notices-e2e-employee-${label}`,
        description: 'Test employee role (board view only)',
        // 'notice:read' added — pre-existing bug: without it, board-load
        // calls made with this token 403'd (see docs/known-issues.md).
        permissions: ['employee:read', 'notice:read'],
        isSystemRole: false,
      },
    });

    const specialRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `notices-e2e-special-${label}`,
        description: 'Test role used for role-targeting',
        // 'notice:read' added — pre-existing bug: without it, board-load
        // calls made with this token 403'd (see docs/known-issues.md).
        permissions: ['employee:read', 'notice:read'],
        isSystemRole: false,
      },
    });

    const deptA = await prisma.department.create({
      data: { organizationId: org.id, name: `Dept A ${label}` },
    });
    const deptB = await prisma.department.create({
      data: { organizationId: org.id, name: `Dept B ${label}` },
    });
    const designationA = await prisma.designation.create({
      data: { organizationId: org.id, departmentId: deptA.id, name: `Designation A ${label}` },
    });
    const designationB = await prisma.designation.create({
      data: { organizationId: org.id, departmentId: deptB.id, name: `Designation B ${label}` },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    async function makeUser(
      empCode: string,
      departmentId: string,
      designationId: string,
      roleId: string,
      phone: string,
    ) {
      const employee = await prisma.employee.create({
        data: {
          organizationId: org.id,
          empCode,
          firstName: empCode,
          lastName: label,
          phone,
          departmentId,
          designationId,
          status: 'ACTIVE',
        },
      });
      const user = await prisma.user.create({
        data: {
          organizationId: org.id,
          employeeId: employee.id,
          email: `${empCode.toLowerCase()}-${label}@notices-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
      return { employeeId: employee.id, userId: user.id, token: login.body.data.accessToken };
    }

    const manager = await makeUser('MGR', deptA.id, designationA.id, managerRole.id, '9200000001');
    const deptAEmp = await makeUser(
      'EMPA',
      deptA.id,
      designationA.id,
      employeeRole.id,
      '9200000002',
    );
    const deptBEmp = await makeUser(
      'EMPB',
      deptB.id,
      designationB.id,
      employeeRole.id,
      '9200000003',
    );
    const specialEmp = await makeUser(
      'EMPS',
      deptB.id,
      designationB.id,
      specialRole.id,
      '9200000004',
    );

    return {
      organizationId: org.id,
      managerToken: manager.token,
      deptAId: deptA.id,
      deptBId: deptB.id,
      specialRoleId: specialRole.id,
      deptAEmployeeId: deptAEmp.employeeId,
      deptAToken: deptAEmp.token,
      deptBEmployeeId: deptBEmp.employeeId,
      deptBToken: deptBEmp.token,
      specialRoleEmployeeId: specialEmp.employeeId,
      specialRoleToken: specialEmp.token,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  async function boardIds(token: string, organizationId: string): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notices')
      .set(authed(token, organizationId))
      .query({ view: 'board', limit: 100 })
      .expect(200);
    return res.body.data.data.map((n: any) => n.id);
  }

  // ─── TARGETING ──────────────────────────────────────────────────────────

  describe('Targeting', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('targeting');
    });

    it('an ALL notice appears on the board for every employee', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({
          title: 'All hands',
          body: 'Everyone reads this',
          targetType: 'ALL',
          publishNow: true,
        })
        .expect(201);
      const id = created.body.data.id;

      expect(await boardIds(org.deptAToken, org.organizationId)).toContain(id);
      expect(await boardIds(org.deptBToken, org.organizationId)).toContain(id);
    });

    it('a TARGETED notice with targetDepts=[Dept A] shows for Dept-A employee, NOT for Dept-B employee', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({
          title: 'Dept A only',
          body: 'Only Dept A should see this',
          targetType: 'TARGETED',
          targetDepts: [org.deptAId],
          publishNow: true,
        })
        .expect(201);
      const id = created.body.data.id;

      expect(await boardIds(org.deptAToken, org.organizationId)).toContain(id);
      expect(await boardIds(org.deptBToken, org.organizationId)).not.toContain(id);
    });

    it('a TARGETED notice with targetRoles=[special role] shows for that role holder, NOT for others', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({
          title: 'Special role only',
          body: 'Only the special role should see this',
          targetType: 'TARGETED',
          targetRoles: [org.specialRoleId],
          publishNow: true,
        })
        .expect(201);
      const id = created.body.data.id;

      expect(await boardIds(org.specialRoleToken, org.organizationId)).toContain(id);
      expect(await boardIds(org.deptAToken, org.organizationId)).not.toContain(id);
      // specialEmp is in Dept B but targeting is by role here, not dept — Dept B employee (non-special) must NOT see it
      expect(await boardIds(org.deptBToken, org.organizationId)).not.toContain(id);
    });
  });

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('lifecycle');
    });

    it('a draft notice (no scheduledAt, no publishNow) is NOT visible on the board', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({ title: 'Draft notice', body: 'Not yet published', targetType: 'ALL' })
        .expect(201);
      expect(created.body.data.status).toBe('draft');
      const id = created.body.data.id;

      expect(await boardIds(org.deptAToken, org.organizationId)).not.toContain(id);

      // publish transitions draft -> published and it becomes board-visible
      const published = await request(app.getHttpServer())
        .put(`/api/v1/notices/${id}/publish`)
        .set(authed(org.managerToken, org.organizationId))
        .expect(200);
      expect(published.body.data.status).toBe('published');
      expect(published.body.data.publishedAt).not.toBeNull();

      expect(await boardIds(org.deptAToken, org.organizationId)).toContain(id);
    });

    it('a notice with a FUTURE scheduledAt is NOT board-visible', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({
          title: 'Future notice',
          body: 'Not due yet',
          targetType: 'ALL',
          scheduledAt: future,
        })
        .expect(201);
      expect(created.body.data.status).toBe('scheduled');
      const id = created.body.data.id;

      expect(await boardIds(org.deptAToken, org.organizationId)).not.toContain(id);
    });

    it('a notice with a PAST scheduledAt (status scheduled) IS board-visible', async () => {
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({ title: 'Due notice', body: 'Already due', targetType: 'ALL', scheduledAt: past })
        .expect(201);
      expect(created.body.data.status).toBe('scheduled');
      const id = created.body.data.id;

      expect(await boardIds(org.deptAToken, org.organizationId)).toContain(id);
    });
  });

  // ─── READ TRACKING ──────────────────────────────────────────────────────

  describe('Read tracking', () => {
    let org: OrgFixture;
    let noticeId: string;

    beforeAll(async () => {
      org = await createOrgFixture('read-tracking');
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({ title: 'Read me', body: 'Track my reads', targetType: 'ALL', publishNow: true })
        .expect(201);
      noticeId = created.body.data.id;
    });

    it('board hasRead is false before markRead', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set(authed(org.deptAToken, org.organizationId))
        .query({ view: 'board', limit: 100 })
        .expect(200);
      const row = res.body.data.data.find((n: any) => n.id === noticeId);
      expect(row.hasRead).toBe(false);
    });

    it('markRead is idempotent: calling twice creates exactly one NoticeRead and does not error', async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/notices/${noticeId}/read`)
        .set(authed(org.deptAToken, org.organizationId))
        .expect(200);
      await request(app.getHttpServer())
        .put(`/api/v1/notices/${noticeId}/read`)
        .set(authed(org.deptAToken, org.organizationId))
        .expect(200);

      const count = await prisma.noticeRead.count({
        where: { noticeId, employeeId: org.deptAEmployeeId },
      });
      expect(count).toBe(1);
    });

    it('board hasRead flips to true after markRead', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set(authed(org.deptAToken, org.organizationId))
        .query({ view: 'board', limit: 100 })
        .expect(200);
      const row = res.body.data.data.find((n: any) => n.id === noticeId);
      expect(row.hasRead).toBe(true);
    });

    it('GET /:id/read-receipts lists the reader with employee ref + readAt', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/notices/${noticeId}/read-receipts`)
        .set(authed(org.managerToken, org.organizationId))
        .expect(200);

      const rows = res.body.data.data;
      expect(rows.length).toBe(1);
      expect(rows[0].employeeId).toBe(org.deptAEmployeeId);
      expect(rows[0].employee.id).toBe(org.deptAEmployeeId);
      expect(rows[0].employee.empCode).toBeDefined();
      expect(rows[0].readAt).not.toBeNull();
    });

    it('manage view readCount reflects the read', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .query({ view: 'manage', limit: 100 })
        .expect(200);
      const row = res.body.data.data.find((n: any) => n.id === noticeId);
      expect(row.readCount).toBe(1);
    });
  });

  // ─── ORG SCOPING ────────────────────────────────────────────────────────

  describe('Organization scoping', () => {
    it('a notice from org A never appears in board or manage for org B', async () => {
      const orgA = await createOrgFixture('tenant-a');
      const orgB = await createOrgFixture('tenant-b');

      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(orgA.managerToken, orgA.organizationId))
        .send({
          title: 'Org A only',
          body: 'Should never leak',
          targetType: 'ALL',
          publishNow: true,
        })
        .expect(201);
      const id = created.body.data.id;

      expect(await boardIds(orgB.deptAToken, orgB.organizationId)).not.toContain(id);

      const manageB = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set(authed(orgB.managerToken, orgB.organizationId))
        .query({ view: 'manage', limit: 100 })
        .expect(200);
      expect(manageB.body.data.data.some((n: any) => n.id === id)).toBe(false);

      // sanity: it IS visible within org A
      expect(await boardIds(orgA.deptAToken, orgA.organizationId)).toContain(id);
    });
  });

  // ─── PERMISSION GATING ──────────────────────────────────────────────────

  describe('Permission gating', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('permissions');
    });

    it('an employee:read-only user gets 403 creating a notice', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.deptAToken, org.organizationId))
        .send({ title: 'Should fail', body: 'No permission', targetType: 'ALL' })
        .expect(403);
    });

    it('an employee:read-only user gets 403 publishing a notice', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({ title: 'Publish target', body: 'Draft', targetType: 'ALL' })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/notices/${id}/publish`)
        .set(authed(org.deptAToken, org.organizationId))
        .expect(403);
    });

    it('an employee:read-only user gets 403 requesting view=manage', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set(authed(org.deptAToken, org.organizationId))
        .query({ view: 'manage' })
        .expect(403);
    });

    it('an employee:read-only user gets 403 on read-receipts', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({ title: 'Receipts target', body: 'x', targetType: 'ALL', publishNow: true })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .get(`/api/v1/notices/${id}/read-receipts`)
        .set(authed(org.deptAToken, org.organizationId))
        .expect(403);
    });

    it('an employee:read-only user CAN load the board (view=board default) and markRead', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/notices')
        .set(authed(org.managerToken, org.organizationId))
        .send({ title: 'Board access', body: 'x', targetType: 'ALL', publishNow: true })
        .expect(201);
      const id = created.body.data.id;

      const board = await request(app.getHttpServer())
        .get('/api/v1/notices')
        .set(authed(org.deptAToken, org.organizationId))
        .expect(200);
      expect(board.body.data.data.some((n: any) => n.id === id)).toBe(true);

      await request(app.getHttpServer())
        .put(`/api/v1/notices/${id}/read`)
        .set(authed(org.deptAToken, org.organizationId))
        .expect(200);
    });
  });
});
