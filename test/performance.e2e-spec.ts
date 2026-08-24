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
 * Performance module (M14) end-to-end coverage:
 *  - Reporting-chain authorization: manager can rate only their own subordinates
 *    (direct or transitive), rejects unrelated employees, self-rating, and users
 *    with no employee record.
 *  - Cycle lifecycle guards: DRAFT -> ACTIVE -> CLOSED, no skipping/reversing,
 *    no double-close, no closing a DRAFT.
 *  - Cycle lock: ratings only accepted while ACTIVE; rejected on DRAFT and CLOSED
 *    (including re-edit-after-close leaving the persisted rating unchanged).
 *  - Multi-tenancy: org B cannot read/close org A's cycle or rate org A's employee.
 *  - Re-submit overwrites cleanly and re-checks ACTIVE + authorization every call.
 *
 * Runs against the real dev MySQL/Redis instance (same as `npm run start:dev`).
 */
describe('Performance module (e2e)', () => {
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

      await prisma.performanceRating.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.performanceCycle.deleteMany({ where: { organizationId } });
      // EmployeeKpi cascades on employee/kpi delete, but Kpi -> Designation is
      // NOT cascading (default Restrict), so Kpi rows must be cleared before
      // designation.deleteMany below or that call throws a FK violation.
      await prisma.employeeKpi.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.kpi.deleteMany({ where: { organizationId } });
      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.loginHistory.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.employee.deleteMany({ where: { organizationId } });
      await prisma.designation.deleteMany({ where: { organizationId } });
      await prisma.department.deleteMany({ where: { organizationId } });
      await prisma.payrollStructure.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await app.close();
  });

  interface OrgFixture {
    organizationId: string;
    departmentId: string;
    designationId: string;
    payrollStructureId: string;
    // admin: has employee:read + payroll:approve (create/activate/close cycles, read)
    adminToken: string;
    adminEmployeeId: string;
    // manager: has employee:read only (rates subordinates)
    managerToken: string;
    managerEmployeeId: string;
    // subordinate: reports to manager
    subordinateToken: string;
    subordinateEmployeeId: string;
    // unrelated: does NOT report to manager
    unrelatedToken: string;
    unrelatedEmployeeId: string;
    // user with employee:read permission but NO employee record
    noEmployeeToken: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `perf-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Perf E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const adminRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `perf-e2e-admin-${label}`,
        description: 'Test admin role',
        permissions: ['employee:read', 'performance:read', 'performance:manage'],
        isSystemRole: false,
      },
    });

    const employeeRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `perf-e2e-employee-${label}`,
        description: 'Test employee role (no performance:manage)',
        permissions: ['employee:read', 'performance:read', 'performance:manage'],
        isSystemRole: false,
      },
    });

    const department = await prisma.department.create({
      data: { organizationId: org.id, name: `Dept ${label}` },
    });
    const designation = await prisma.designation.create({
      data: { organizationId: org.id, departmentId: department.id, name: `Designation ${label}` },
    });
    const payrollStructure = await prisma.payrollStructure.create({
      data: {
        organizationId: org.id,
        name: `Structure ${label}`,
        components: { basic: 30000, hra: 10000 },
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    async function makeUser(
      empCodePrefix: string,
      role: { id: string },
      reportingManagerId?: string,
    ) {
      const employee = await prisma.employee.create({
        data: {
          organizationId: org.id,
          empCode: `${empCodePrefix}-${label}`,
          firstName: empCodePrefix,
          lastName: label,
          phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
          departmentId: department.id,
          designationId: designation.id,
          payrollStructureId: payrollStructure.id,
          status: 'ACTIVE',
          ...(reportingManagerId ? { reportingManagerId } : {}),
        },
      });
      const user = await prisma.user.create({
        data: {
          organizationId: org.id,
          employeeId: employee.id,
          email: `${empCodePrefix.toLowerCase()}-${label}@perf-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
      return { employeeId: employee.id, token: login.body.data.accessToken, userId: user.id };
    }

    const admin = await makeUser('ADMIN', adminRole);
    const manager = await makeUser('MGR', employeeRole);
    const subordinate = await makeUser('SUB', employeeRole, manager.employeeId);
    const unrelated = await makeUser('UNREL', employeeRole);

    // user with employee:read permission but no employee record at all
    const noEmployeeUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `noemp-${label}@perf-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: noEmployeeUser.id, roleId: employeeRole.id } });
    const noEmployeeLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: noEmployeeUser.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      departmentId: department.id,
      designationId: designation.id,
      payrollStructureId: payrollStructure.id,
      adminToken: admin.token,
      adminEmployeeId: admin.employeeId,
      managerToken: manager.token,
      managerEmployeeId: manager.employeeId,
      subordinateToken: subordinate.token,
      subordinateEmployeeId: subordinate.employeeId,
      unrelatedToken: unrelated.token,
      unrelatedEmployeeId: unrelated.employeeId,
      noEmployeeToken: noEmployeeLogin.body.data.accessToken,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  async function createCycle(org: OrgFixture, name: string, status?: 'DRAFT' | 'ACTIVE') {
    const res = await request(app.getHttpServer())
      .post('/api/v1/performance/cycles')
      .set(authed(org.adminToken, org.organizationId))
      .send({
        name,
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-03-31T00:00:00.000Z',
        ...(status ? { status } : {}),
      })
      .expect(201);
    return res.body.data;
  }

  // ─── POST /performance/cycles + GET /performance/cycles ────────────────────

  describe('POST /performance/cycles + GET /performance/cycles', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('cycles');
    });

    it('creates a DRAFT cycle by default', async () => {
      const cycle = await createCycle(org, `Q1-${uuid()}`);
      expect(cycle.status).toBe('DRAFT');
      expect(cycle.closedAt).toBeNull();
    });

    it('rejects creating a duplicate-named cycle in the same org', async () => {
      const name = `Dup-${uuid()}`;
      await createCycle(org, name);
      await request(app.getHttpServer())
        .post('/api/v1/performance/cycles')
        .set(authed(org.adminToken, org.organizationId))
        .send({ name, startDate: '2026-01-01', endDate: '2026-03-31' })
        .expect(400);
    });

    it('rejects creating a cycle as CLOSED', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/performance/cycles')
        .set(authed(org.adminToken, org.organizationId))
        .send({
          name: `Closed-${uuid()}`,
          startDate: '2026-01-01',
          endDate: '2026-03-31',
          status: 'CLOSED',
        })
        .expect(400);
    });

    it('lists cycles paginated, org-scoped', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/performance/cycles')
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(Array.isArray(res.body.data.data)).toBe(true);
      expect(res.body.data.meta).toBeDefined();
    });

    it('GET /performance/cycles/:id returns the single cycle', async () => {
      const cycle = await createCycle(org, `Single-${uuid()}`);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/performance/cycles/${cycle.id}`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(res.body.data.id).toBe(cycle.id);
    });
  });

  // ─── Lifecycle guards ────────────────────────────────────────────────────

  describe('Lifecycle guards: activate/close', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('lifecycle');
    });

    it('activates a DRAFT cycle -> ACTIVE', async () => {
      const cycle = await createCycle(org, `Life-${uuid()}`);
      const res = await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('rejects activating a non-DRAFT cycle (already ACTIVE)', async () => {
      const cycle = await createCycle(org, `Life2-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(400);
    });

    it('rejects closing a DRAFT cycle', async () => {
      const cycle = await createCycle(org, `Life3-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/close`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(400);
    });

    it('closes an ACTIVE cycle -> CLOSED, sets closedAt', async () => {
      const cycle = await createCycle(org, `Life4-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      const res = await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/close`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(res.body.data.status).toBe('CLOSED');
      expect(res.body.data.closedAt).not.toBeNull();
    });

    it('rejects double-close', async () => {
      const cycle = await createCycle(org, `Life5-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/close`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/close`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(400);
    });
  });

  // ─── Ratings: authorization (reporting-chain) ───────────────────────────────

  describe('POST /performance/cycles/:id/ratings — reporting-chain authorization', () => {
    let org: OrgFixture;
    let activeCycle: any;

    beforeAll(async () => {
      org = await createOrgFixture('rating-auth');
      const cycle = await createCycle(org, `Auth-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      activeCycle = cycle;
    });

    it('manager can rate their direct subordinate (200/201)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${activeCycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ employeeId: org.subordinateEmployeeId, rating: 4, comments: 'Solid quarter' })
        .expect(201);
      expect(res.body.data.rating).toBe(4);
      expect(res.body.data.ratedBy).toBe(org.managerEmployeeId);
      expect(res.body.data.employeeId).toBe(org.subordinateEmployeeId);
    });

    it('manager rating an unrelated (non-subordinate) employee is rejected (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${activeCycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ employeeId: org.unrelatedEmployeeId, rating: 5 })
        .expect(403);
    });

    it('user with no employee record is rejected (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${activeCycle.id}/ratings`)
        .set(authed(org.noEmployeeToken, org.organizationId))
        .send({ employeeId: org.subordinateEmployeeId, rating: 3 })
        .expect(403);
    });

    it('rater === ratee (self-rating) is rejected (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${activeCycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ employeeId: org.managerEmployeeId, rating: 5 })
        .expect(403);
    });
  });

  // ─── Cycle lock: DRAFT / ACTIVE / CLOSED ────────────────────────────────────

  describe('Cycle lock: rating only accepted while ACTIVE', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('cycle-lock');
    });

    it('rejects submitting a rating on a DRAFT cycle (400)', async () => {
      const cycle = await createCycle(org, `Draft-${uuid()}`);
      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ employeeId: org.subordinateEmployeeId, rating: 4 })
        .expect(400);
    });

    it('accepts a rating on an ACTIVE cycle, rejects edits after CLOSE, and leaves the persisted rating unchanged', async () => {
      const cycle = await createCycle(org, `ActiveThenClose-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      const firstSubmit = await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ employeeId: org.subordinateEmployeeId, rating: 3, comments: 'Initial' })
        .expect(201);
      expect(firstSubmit.body.data.rating).toBe(3);

      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/close`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({
          employeeId: org.subordinateEmployeeId,
          rating: 5,
          comments: 'Trying to edit after close',
        })
        .expect(400);

      // persisted rating is unchanged
      const listRes = await request(app.getHttpServer())
        .get(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      const persisted = listRes.body.data.data.find(
        (r: any) => r.employeeId === org.subordinateEmployeeId,
      );
      expect(persisted.rating).toBe(3);
      expect(persisted.comments).toBe('Initial');
    });
  });

  // ─── Re-submit overwrite semantics ──────────────────────────────────────────

  describe('Re-submit overwrite semantics', () => {
    let org: OrgFixture;
    let cycle: any;

    beforeAll(async () => {
      org = await createOrgFixture('resubmit');
      cycle = await createCycle(org, `Resubmit-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
    });

    it('re-submitting the same cycle+employee overwrites cleanly (no duplicate rows)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ employeeId: org.subordinateEmployeeId, rating: 2, comments: 'First pass' })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ employeeId: org.subordinateEmployeeId, rating: 5, comments: 'Revised upward' })
        .expect(201);
      expect(second.body.data.rating).toBe(5);
      expect(second.body.data.comments).toBe('Revised upward');

      const listRes = await request(app.getHttpServer())
        .get(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      const matches = listRes.body.data.data.filter(
        (r: any) => r.employeeId === org.subordinateEmployeeId,
      );
      expect(matches.length).toBe(1); // no duplicate row from upsert
      expect(matches[0].rating).toBe(5);
    });

    it('re-checks authorization on the second call too (unrelated rater still 403 on re-submit attempt)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.unrelatedToken, org.organizationId))
        .send({ employeeId: org.subordinateEmployeeId, rating: 1 })
        .expect(403);
    });
  });

  // ─── GET /performance/my-ratings ────────────────────────────────────────────

  describe('GET /performance/my-ratings', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('my-ratings');
    });

    it("returns only the caller's own ratings across cycles", async () => {
      const cycle = await createCycle(org, `MyRatings-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycle.id}/activate`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${cycle.id}/ratings`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ employeeId: org.subordinateEmployeeId, rating: 4 })
        .expect(201);

      const subordinateView = await request(app.getHttpServer())
        .get('/api/v1/performance/my-ratings')
        .set(authed(org.subordinateToken, org.organizationId))
        .expect(200);
      expect(subordinateView.body.data.data.length).toBeGreaterThanOrEqual(1);
      expect(
        subordinateView.body.data.data.every(
          (r: any) => r.employeeId === org.subordinateEmployeeId,
        ),
      ).toBe(true);

      const unrelatedView = await request(app.getHttpServer())
        .get('/api/v1/performance/my-ratings')
        .set(authed(org.unrelatedToken, org.organizationId))
        .expect(200);
      expect(unrelatedView.body.data.data.length).toBe(0);
    });
  });

  // ─── Multi-tenancy ──────────────────────────────────────────────────────────

  describe('Multi-tenancy scoping', () => {
    let orgA: OrgFixture;
    let orgB: OrgFixture;
    let cycleInOrgA: any;

    beforeAll(async () => {
      orgA = await createOrgFixture('tenant-a');
      orgB = await createOrgFixture('tenant-b');
      cycleInOrgA = await createCycle(orgA, `TenantA-${uuid()}`);
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycleInOrgA.id}/activate`)
        .set(authed(orgA.adminToken, orgA.organizationId))
        .expect(200);
    });

    it("org B cannot GET org A's cycle (404, not leaked)", async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/performance/cycles/${cycleInOrgA.id}`)
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(404);
    });

    it("org B cannot close org A's cycle (404, not leaked)", async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/performance/cycles/${cycleInOrgA.id}/close`)
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(404);
    });

    it("org B's cycle list never includes org A's cycle", async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/performance/cycles')
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(200);
      expect(list.body.data.data.some((c: any) => c.id === cycleInOrgA.id)).toBe(false);
    });

    it("org B manager cannot rate org A's employee (404, cross-org employee lookup fails)", async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/performance/cycles/${cycleInOrgA.id}/ratings`)
        .set(authed(orgB.managerToken, orgB.organizationId))
        .send({ employeeId: orgA.subordinateEmployeeId, rating: 3 })
        .expect(404);
    });
  });

  // ─── GET /performance/kpis ──────────────────────────────────────────────────

  describe('GET /performance/kpis', () => {
    let org: OrgFixture;
    let otherDesignationId: string;
    let kpiA1: { id: string };
    let kpiA2: { id: string };
    let noPermToken: string;

    beforeAll(async () => {
      org = await createOrgFixture('kpis');

      const otherDesignation = await prisma.designation.create({
        data: {
          organizationId: org.organizationId,
          departmentId: org.departmentId,
          name: `Other Designation ${uuid()}`,
        },
      });
      otherDesignationId = otherDesignation.id;

      kpiA1 = await prisma.kpi.create({
        data: {
          organizationId: org.organizationId,
          designationId: org.designationId,
          title: `Sales Target ${uuid()}`,
          targetValue: 100,
          unit: 'units',
        },
      });
      kpiA2 = await prisma.kpi.create({
        data: {
          organizationId: org.organizationId,
          designationId: otherDesignationId,
          title: `Attendance ${uuid()}`,
          targetValue: 95,
          unit: '%',
        },
      });

      await prisma.employeeKpi.create({
        data: {
          employeeId: org.subordinateEmployeeId,
          kpiId: kpiA1.id,
          status: 'IN_PROGRESS',
          achievedValue: 40,
        },
      });
      await prisma.employeeKpi.create({
        data: {
          employeeId: org.managerEmployeeId,
          kpiId: kpiA2.id,
          status: 'ACHIEVED',
          achievedValue: 96,
        },
      });

      // Role with NO employee:read permission, for the 403 boundary check.
      const noPermRole = await prisma.role.create({
        data: {
          organizationId: org.organizationId,
          name: `perf-e2e-kpis-noperm-${uuid()}`,
          description: 'No permissions at all',
          permissions: [],
          isSystemRole: false,
        },
      });
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const noPermUser = await prisma.user.create({
        data: {
          organizationId: org.organizationId,
          email: `noperm-kpis-${uuid()}@perf-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: noPermUser.id, roleId: noPermRole.id } });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: noPermUser.email, password: PASSWORD })
        .expect(200);
      noPermToken = login.body.data.accessToken;
    });

    it('returns the exact documented row shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/performance/kpis')
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      expect(Array.isArray(res.body.data.data)).toBe(true);
      expect(res.body.data.meta).toBeDefined();

      const row = res.body.data.data.find((r: any) => r.kpiTitle === kpiA1.id || r.employeeId);
      expect(row).toBeDefined();
      expect(Object.keys(row).sort()).toEqual(
        [
          'id',
          'employeeId',
          'employeeName',
          'designationId',
          'designationName',
          'kpiTitle',
          'targetValue',
          'unit',
          'achievedValue',
          'status',
        ].sort(),
      );
    });

    it('filters by designationId', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/performance/kpis')
        .query({ designationId: otherDesignationId })
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      expect(res.body.data.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.data.every((r: any) => r.designationId === otherDesignationId)).toBe(
        true,
      );
    });

    it('filters by status', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/performance/kpis')
        .query({ status: 'ACHIEVED' })
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      expect(res.body.data.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.data.every((r: any) => r.status === 'ACHIEVED')).toBe(true);
    });

    it('paginates with correct meta', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/performance/kpis')
        .query({ page: 1, limit: 1 })
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      expect(res.body.data.data.length).toBe(1);
      expect(res.body.data.meta.page).toBe(1);
      expect(res.body.data.meta.limit).toBe(1);
      expect(res.body.data.meta.total).toBeGreaterThanOrEqual(2);
    });

    it('rejects unauthenticated requests (401)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/performance/kpis')
        .set('X-Organization-ID', org.organizationId)
        .expect(401);
    });

    it('rejects requests missing the employee:read permission (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/performance/kpis')
        .set(authed(noPermToken, org.organizationId))
        .expect(403);
    });

    it("org B never sees org A's KPI assignments (multi-tenancy)", async () => {
      const orgB = await createOrgFixture('kpis-tenant-b');
      const res = await request(app.getHttpServer())
        .get('/api/v1/performance/kpis')
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(200);
      expect(res.body.data.data.some((r: any) => r.employeeId === org.subordinateEmployeeId)).toBe(
        false,
      );
    });
  });
});
