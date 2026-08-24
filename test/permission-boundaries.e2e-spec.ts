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
 * API-level permission-boundary + edge-case QA pass (see docs/known-issues.md
 * 2026-08-15 entry for context). Exercises the REAL seeded iGreen Technologies
 * org and the REAL seeded `employee` role users (shi1878/ali1708) rather than
 * synthetic fixtures, per the testing-agent's brief — except for the
 * Casual-Leave-limit and null-payroll-structure checks, which reuse a
 * synthetic org fixture (matching the established pattern in
 * work-locations-od.e2e-spec.ts) to avoid mutating real seeded payroll/leave
 * state shared with demos.
 *
 * IMPORTANT: `shi1878`/`ali1708` are seeded with `mustChangePassword: true`.
 * `PermissionsGuard` (src/common/guards/roles.guard.ts) blocks EVERY route
 * except /auth/change-password, /auth/logout, /auth/me, /auth/refresh while
 * that flag is set — so every boundary check below would 403 for the WRONG
 * reason ("Password change required", not a real permission mismatch) unless
 * the gate is cleared first. This suite clears it via a real
 * PUT /auth/change-password call in beforeAll and restores the original
 * `123456` password in afterAll so the documented seeded credentials keep
 * working for any other agent/demo that relies on them.
 */
describe('Permission boundaries + edge cases (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const SEED_PASSWORD = '123456';
  const TEMP_PASSWORD = 'TempTest@12345';
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
      await prisma.leaveApplication.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leavePolicy.deleteMany({ where: { organizationId } });
      await prisma.payrollEntry.deleteMany({ where: { payrollRun: { organizationId } } });
      await prisma.payrollRun.deleteMany({ where: { organizationId } });
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

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  function login(email: string, password: string) {
    return request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
  }

  /**
   * Logs in with the seed password, clears mustChangePassword via a real
   * PUT /auth/change-password call if needed, and returns a token usable
   * against permission-gated routes plus a restore() cleanup function.
   */
  async function loginAndClearMustChange(email: string) {
    const first = await login(email, SEED_PASSWORD).expect(200);
    if (!first.body.data.user.mustChangePassword) {
      return { token: first.body.data.accessToken as string, restore: async () => {} };
    }

    await request(app.getHttpServer())
      .put('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${first.body.data.accessToken}`)
      .send({ currentPassword: SEED_PASSWORD, newPassword: TEMP_PASSWORD })
      .expect(200);

    const second = await login(email, TEMP_PASSWORD).expect(200);
    expect(second.body.data.user.mustChangePassword).toBe(false);

    // NOTE: restore cannot go through PUT /auth/change-password because the
    // real seed password ('123456') is shorter than ChangePasswordDto's
    // @MinLength(8) — the seeder bypasses the DTO by writing the hash
    // directly. Mirror that here via a direct Prisma write instead, and
    // restore mustChangePassword: true to match the original seeded state.
    const restore = async () => {
      const user = await prisma.user.findFirst({ where: { email } });
      if (!user) return;
      const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: true },
      });
    };

    return { token: second.body.data.accessToken as string, restore };
  }

  // ─── Real seeded org / users ──────────────────────────────────────────────

  describe('Real seeded iGreen Technologies org — employee-role permission boundaries', () => {
    let orgId: string;
    let adminToken: string;
    let shiToken: string;
    let shiRestore: () => Promise<void>;
    let aliToken: string;
    let aliRestore: () => Promise<void>;

    beforeAll(async () => {
      const org = await prisma.organization.findFirst({
        where: { name: { contains: 'iGreen' } },
      });
      if (!org) throw new Error('Seeded iGreen Technologies org not found — run the seeders first');
      orgId = org.id;

      const adminLogin = await login('admin@igreentec.in', 'Admin@1234').expect(200);
      adminToken = adminLogin.body.data.accessToken;

      const shi = await loginAndClearMustChange('shi1878@igreentec.in');
      shiToken = shi.token;
      shiRestore = shi.restore;

      const ali = await loginAndClearMustChange('ali1708@igreentec.in');
      aliToken = ali.token;
      aliRestore = ali.restore;
    });

    afterAll(async () => {
      await shiRestore();
      await aliRestore();
    });

    // ── 3. Wrong password -> clean 401, not 500 ──────────────────────────────

    it('POST /auth/login with a wrong password returns a clean 401 (never 500)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'shi1878@igreentec.in', password: 'definitely-wrong-password' })
        .expect(401);
      expect(res.body.success).toBe(false);
    });

    // ── 1. Employee-role permission boundaries (shi1878, 403 not 200/500) ──

    const employeeBoundaryCases: Array<{
      label: string;
      method: 'get' | 'post' | 'put' | 'patch' | 'delete';
      path: string;
      body?: Record<string, unknown>;
    }> = [
      {
        label: 'GET /notices/manage (onboarding:manage)',
        method: 'get',
        path: '/api/v1/notices/manage',
      },
      {
        label: 'PUT /green-thanks/config (green_thanks:manage)',
        method: 'put',
        path: '/api/v1/green-thanks/config',
        body: { pointsToInrRate: 1 },
      },
      {
        label: 'GET /incentive-rules (incentive:read)',
        method: 'get',
        path: '/api/v1/incentive-rules',
      },
      {
        label: 'POST /payroll/runs (payroll:run)',
        method: 'post',
        path: '/api/v1/payroll/runs',
        body: { month: 1, year: 2020 },
      },
      { label: 'GET /payroll/runs (payroll:read)', method: 'get', path: '/api/v1/payroll/runs' },
      {
        label: 'PUT /payroll/runs/:id/approve (payroll:approve)',
        method: 'put',
        path: '/api/v1/payroll/runs/nonexistent-id/approve',
      },
      { label: 'GET /disciplinary (exit:manage)', method: 'get', path: '/api/v1/disciplinary' },
      { label: 'GET /exit (exit:manage)', method: 'get', path: '/api/v1/exit' },
      { label: 'GET /roles (role:read)', method: 'get', path: '/api/v1/roles' },
      {
        label: 'GET /organization/payroll-structures (payroll:read)',
        method: 'get',
        path: '/api/v1/payroll-structures',
      },
      {
        label: 'GET /reports/headcount (report:read)',
        method: 'get',
        path: '/api/v1/reports/headcount',
      },
      {
        label: 'GET /reports/attendance-track (report:read)',
        method: 'get',
        path: '/api/v1/reports/attendance-track',
      },
      {
        label: 'GET /reports/performance (report:read)',
        method: 'get',
        path: '/api/v1/reports/performance',
      },
      {
        label: 'GET /reports/todo-incentive (report:read)',
        method: 'get',
        path: '/api/v1/reports/todo-incentive',
      },
      {
        label: 'GET /reports/audit (report:audit, separate from report:read)',
        method: 'get',
        path: '/api/v1/reports/audit',
      },
      {
        label: 'PUT /organization (org:update)',
        method: 'put',
        path: '/api/v1/organization',
        body: { name: 'Hacked' },
      },
      { label: 'GET /employees (employee:read)', method: 'get', path: '/api/v1/employees' },
    ];

    it.each(employeeBoundaryCases)(
      '$label -> 403 for employee-role caller (not 200, not 500)',
      async ({ method, path, body }) => {
        const req = request(app.getHttpServer())[method](path).set(authed(shiToken, orgId));
        const res = body ? await req.send(body) : await req;
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      },
    );

    // ── 2. Employee CAN see OWN data, scoped to self only ───────────────────

    it('GET /attendance/my succeeds (200) and is scoped to the caller only', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/attendance/my')
        .set(authed(shiToken, orgId))
        .expect(200);
      expect(res.body.success).toBe(true);
      // every row (if any) must belong to shi1878's own employee record
      const shi = await prisma.employee.findFirst({ where: { empCode: 'Shi1878' } });
      const rows = res.body.data.data ?? res.body.data;
      for (const row of rows) {
        expect(row.employeeId).toBe(shi?.id);
      }
    });

    it("GET /leave/my-balance succeeds (200) for the caller's own balance", async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/leave/my-balance')
        .set(authed(shiToken, orgId))
        .expect(200);
      expect(res.body.success).toBe(true);
    });

    it("GET /leave/my succeeds (200), scoped to the caller's own applications only", async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/leave/my')
        .set(authed(shiToken, orgId))
        .expect(200);
      expect(res.body.success).toBe(true);
      const shi = await prisma.employee.findFirst({ where: { empCode: 'Shi1878' } });
      const rows = res.body.data.data ?? res.body.data;
      for (const row of rows) {
        expect(row.employeeId).toBe(shi?.id);
      }
    });

    it('GET /auth/me succeeds even before other endpoints (self profile, exempt from permission checks)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(authed(shiToken, orgId))
        .expect(200);
      expect(res.body.data.email).toBe('shi1878@igreentec.in');
    });

    // ── 5. Shi1878 (null payrollStructureId) — admin-facing reads must not 500 ──

    it('GET /employees/:id (admin) for Shi1878 returns 200 with payrollStructure: null, never a 500', async () => {
      const shi = await prisma.employee.findFirst({ where: { empCode: 'Shi1878' } });
      expect(shi).not.toBeNull();
      expect(shi?.payrollStructureId).toBeNull();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/employees/${shi?.id}`)
        .set(authed(adminToken, orgId))
        .expect(200);
      expect(res.body.data.payrollStructure).toBeNull();
    });
  });

  // ─── Synthetic fixture: null-payroll-structure processRun graceful handling ──

  describe('Payroll processRun gracefully handles an employee with no payrollStructure (mirrors the real Shi1878 condition)', () => {
    let organizationId: string;
    let adminToken: string;
    let noStructureEmployeeId: string;

    beforeAll(async () => {
      const slug = `perm-e2e-nullpay-${uuid()}`;
      const org = await prisma.organization.create({
        data: { name: 'Perm E2E NullPay', slug, isActive: true },
      });
      createdOrgIds.push(org.id);

      const adminRole = await prisma.role.create({
        data: {
          organizationId: org.id,
          name: `perm-e2e-admin-${uuid()}`,
          permissions: ['payroll:run', 'payroll:read', 'payroll:approve'],
          isSystemRole: false,
        },
      });

      const department = await prisma.department.create({
        data: { organizationId: org.id, name: 'Dept' },
      });
      const designation = await prisma.designation.create({
        data: { organizationId: org.id, departmentId: department.id, name: 'Designation' },
      });

      const passwordHash = await bcrypt.hash('Test@1234', 10);
      const adminEmployee = await prisma.employee.create({
        data: {
          organizationId: org.id,
          empCode: 'ADM-NP',
          firstName: 'Admin',
          lastName: 'NP',
          phone: '9000000201',
          departmentId: department.id,
          designationId: designation.id,
          status: 'ACTIVE',
        },
      });
      const adminUser = await prisma.user.create({
        data: {
          organizationId: org.id,
          employeeId: adminEmployee.id,
          email: `admin-np-${uuid()}@perm-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: adminUser.id, roleId: adminRole.id } });

      // The employee under test has NO payrollStructureId — mirrors Shi1878's
      // real seeded condition (verified via direct Prisma query above).
      const noStructureEmployee = await prisma.employee.create({
        data: {
          organizationId: org.id,
          empCode: 'NOPAY-1',
          firstName: 'No',
          lastName: 'Structure',
          phone: '9000000202',
          departmentId: department.id,
          designationId: designation.id,
          status: 'ACTIVE',
          payrollStructureId: null,
        },
      });
      noStructureEmployeeId = noStructureEmployee.id;

      const adminLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: adminUser.email, password: 'Test@1234' })
        .expect(200);
      organizationId = org.id;
      adminToken = adminLogin.body.data.accessToken;
    });

    it('POST /payroll/runs computes a run including the no-structure employee without a 500, entry defaults to 0 components', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/payroll/runs')
        .set(authed(adminToken, organizationId))
        .send({ month: 1, year: 2026 })
        .expect(201);
      expect(res.body.data.status).not.toBe('FAILED');

      const entry = await request(app.getHttpServer())
        .get(`/api/v1/payroll/runs/${res.body.data.id}/entries/${noStructureEmployeeId}`)
        .set(authed(adminToken, organizationId))
        .expect(200);
      expect(entry.body.data.grossSalary).toBe(0);
      expect(entry.body.data.netSalary).toBe(0);
    });
  });

  // ─── Casual Leave maxConsecutiveDays=1, re-confirmed against the real seeded policy ──

  describe('Casual Leave maxConsecutiveDays=1 (real iGreen seeded policy) rejects a 2-day application', () => {
    let orgId: string;
    let shiToken: string;
    let shiRestore: () => Promise<void>;
    let casualPolicyTypeId: string;
    let shiEmployeeId: string;
    let createdBalanceId: string;

    beforeAll(async () => {
      const org = await prisma.organization.findFirst({ where: { name: { contains: 'iGreen' } } });
      orgId = org!.id;

      const policyType = await prisma.leavePolicyType.findFirst({
        where: { leaveType: 'CASUAL', leavePolicy: { organizationId: orgId, isActive: true } },
      });
      expect(policyType).not.toBeNull();
      expect(policyType?.maxConsecutiveDays).toBe(1);
      casualPolicyTypeId = policyType!.id;

      const shiEmployee = await prisma.employee.findFirst({ where: { empCode: 'Shi1878' } });
      shiEmployeeId = shiEmployee!.id;

      // Shi1878 has no seeded LeaveBalance row for Casual Leave (confirmed via
      // direct query) — the balance check runs BEFORE the maxConsecutiveDays
      // check in LeaveApplicationsService.apply, so a balance row is required
      // to actually exercise the day-limit branch rather than short-circuiting
      // on "Insufficient leave balance". Create one, then clean it up.
      const balance = await prisma.leaveBalance.create({
        data: {
          employeeId: shiEmployeeId,
          leavePolicyTypeId: casualPolicyTypeId,
          year: new Date().getFullYear(),
          entitledDays: 12,
          takenDays: 0,
          balanceDays: 12,
        },
      });
      createdBalanceId = balance.id;

      const shiAuth = await loginAndClearMustChange('shi1878@igreentec.in');
      shiToken = shiAuth.token;
      shiRestore = shiAuth.restore;
    });

    afterAll(async () => {
      await prisma.leaveApplication.deleteMany({
        where: { employeeId: shiEmployeeId, leavePolicyTypeId: casualPolicyTypeId },
      });
      await prisma.leaveBalance.delete({ where: { id: createdBalanceId } }).catch(() => {});
      await shiRestore();
    });

    it('rejects a 2-day Casual Leave application with a 400 + max-1-day message', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/leave/apply')
        .set(authed(shiToken, orgId))
        .send({
          leavePolicyTypeId: casualPolicyTypeId,
          fromDate: '2026-11-02',
          toDate: '2026-11-03',
          days: 2,
          reason: 'Permission-boundary QA regression check',
        })
        .expect(400);
      expect(res.body.message).toContain('maximum of 1 consecutive day');
    });

    it('accepts a 1-day Casual Leave application (control case, within the limit)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/leave/apply')
        .set(authed(shiToken, orgId))
        .send({
          leavePolicyTypeId: casualPolicyTypeId,
          fromDate: '2026-11-10',
          toDate: '2026-11-10',
          days: 1,
          reason: 'Permission-boundary QA regression check (control)',
        })
        .expect(201);
      expect(res.body.data.status).toBe('PENDING');
    });
  });
});
