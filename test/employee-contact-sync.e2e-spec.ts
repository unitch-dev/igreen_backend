import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * Regression suite for the Employee <-> User contact-field sync fix
 * (2026-09-02): editing Employee.phone/email via the admin PUT :id or the
 * self-service PATCH :id/self endpoint previously did NOT propagate to the
 * linked User row, so OTP login (which queries User by phone) 404'd for the
 * employee's new, visibly-saved phone number. `EmployeesService.update()`
 * and `.updateSelf()` now wrap the employee write + `user.updateMany` sync
 * in a single `$transaction` and translate a P2002 email collision into a
 * clean 409. See docs/known-issues.md (2026-09-02 entry).
 *
 * Fixtures are created directly against the real seeded iGreen Technologies
 * org (reusing its department/designation/payroll-structure/role rows) but
 * as brand-new synthetic Employee/User/UserRole rows, so this suite never
 * mutates the real seeded admin/shi1878/ali1708 accounts and needs no
 * password-restore dance (see docs/known-issues.md 2026-08-18 for why that
 * matters) — cleanup just deletes the rows it created.
 */
describe('Employee <-> User contact-field sync (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let orgId: string;
  let adminToken: string;
  let departmentId: string;
  let designationId: string;
  let payrollStructureId: string | null;
  let employeeRoleId: string;

  const createdEmployeeIds: string[] = [];
  const createdUserIds: string[] = [];

  const SELF_PASSWORD = 'SelfSync@12345';

  function headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': orgId,
    };
  }

  async function createEmployeeWithUser(opts: {
    empCode: string;
    phone: string;
    email: string;
    withUser?: boolean;
    password?: string;
    assignEmployeeRole?: boolean;
  }) {
    const { empCode, phone, email, withUser = true, password, assignEmployeeRole = false } = opts;

    const employee = await prisma.employee.create({
      data: {
        organizationId: orgId,
        empCode,
        firstName: 'Sync',
        lastName: 'Fixture',
        email,
        phone,
        departmentId,
        designationId,
        payrollStructureId,
        status: 'ACTIVE',
      },
    });
    createdEmployeeIds.push(employee.id);

    if (withUser) {
      const passwordHash = await bcrypt.hash(password ?? 'unused-placeholder-1234', 10);
      const user = await prisma.user.create({
        data: {
          organizationId: orgId,
          employeeId: employee.id,
          email,
          phone,
          passwordHash,
          isActive: true,
          mustChangePassword: false,
        },
      });
      createdUserIds.push(user.id);

      if (assignEmployeeRole) {
        await prisma.userRole.create({
          data: { userId: user.id, roleId: employeeRoleId },
        });
      }
    }

    return employee;
  }

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

    const org = await prisma.organization.findFirst({ where: { name: { contains: 'iGreen' } } });
    if (!org) throw new Error('Seeded iGreen Technologies org not found — run the seeders first');
    orgId = org.id;

    const dept = await prisma.department.findFirst({ where: { organizationId: orgId } });
    const desig = await prisma.designation.findFirst({ where: { organizationId: orgId } });
    const payrollStructure = await prisma.payrollStructure.findFirst({
      where: { organizationId: orgId },
    });
    const employeeRole = await prisma.role.findFirst({
      where: { organizationId: orgId, name: 'employee' },
    });
    if (!dept || !desig || !employeeRole) {
      throw new Error('Seeded iGreen org is missing department/designation/employee role fixtures');
    }
    departmentId = dept.id;
    designationId = desig.id;
    payrollStructureId = payrollStructure?.id ?? null;
    employeeRoleId = employeeRole.id;

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin@igreentec.in', password: 'Admin@1234' })
      .expect(200);
    adminToken = adminLogin.body.data.accessToken;
  });

  afterAll(async () => {
    await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.loginHistory.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: createdEmployeeIds } } });
    await app.close();
  });

  // ── (a) THE CRITICAL ROUND-TRIP: admin phone edit -> OTP send with NEW number ──

  describe('(a) admin PUT /employees/:id phone edit syncs to User, OTP send works with new number', () => {
    const OLD_PHONE = '9911100001';
    const NEW_PHONE = '9911100002';
    let employeeId: string;

    beforeAll(async () => {
      const emp = await createEmployeeWithUser({
        empCode: 'SYNC-A',
        phone: OLD_PHONE,
        email: 'sync-a@test.local',
      });
      employeeId = emp.id;
    });

    it('OTP send with the OLD number works before the edit (sanity check)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/send')
        .send({ phone: OLD_PHONE })
        .expect(200);
    });

    it('admin PUT /employees/:id changes the phone, then OTP send with the NEW number returns 200 (not 404)', async () => {
      const updateRes = await request(app.getHttpServer())
        .put(`/api/v1/employees/${employeeId}`)
        .set(headers(adminToken))
        .send({ phone: NEW_PHONE })
        .expect(200);
      expect(updateRes.body.success).toBe(true);
      expect(updateRes.body.data.phone).toBe(NEW_PHONE);

      const dbUser = await prisma.user.findFirst({ where: { employeeId } });
      expect(dbUser?.phone).toBe(NEW_PHONE);

      const otpRes = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/send')
        .send({ phone: NEW_PHONE })
        .expect(200);
      expect(otpRes.body.success).toBe(true);
      expect(otpRes.body.data.sent).toBe(true);
    });

    it('OTP send with the OLD (now-stale) number returns 404', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/send')
        .send({ phone: OLD_PHONE })
        .expect(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ── (b) self-service round-trip ──────────────────────────────────────────

  describe('(b) self-service PATCH /employees/:id/self phone edit syncs to User', () => {
    const OLD_PHONE = '9911100011';
    const NEW_PHONE = '9911100012';
    let employeeId: string;
    let selfToken: string;

    beforeAll(async () => {
      const emp = await createEmployeeWithUser({
        empCode: 'SYNC-B',
        phone: OLD_PHONE,
        email: 'sync-b@test.local',
        password: SELF_PASSWORD,
        assignEmployeeRole: true,
      });
      employeeId = emp.id;

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'sync-b@test.local', password: SELF_PASSWORD })
        .expect(200);
      selfToken = login.body.data.accessToken;
      expect(login.body.data.user.mustChangePassword).toBe(false);
    });

    it('self PATCH changes own phone, then OTP send with the NEW number returns 200', async () => {
      const updateRes = await request(app.getHttpServer())
        .patch(`/api/v1/employees/${employeeId}/self`)
        .set(headers(selfToken))
        .send({ phone: NEW_PHONE })
        .expect(200);
      expect(updateRes.body.success).toBe(true);
      expect(updateRes.body.data.phone).toBe(NEW_PHONE);

      const dbUser = await prisma.user.findFirst({ where: { employeeId } });
      expect(dbUser?.phone).toBe(NEW_PHONE);

      const otpRes = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/send')
        .send({ phone: NEW_PHONE })
        .expect(200);
      expect(otpRes.body.success).toBe(true);
    });
  });

  // ── (c) email sync via admin update ──────────────────────────────────────

  describe('(c) admin email edit syncs to User.email (verified via direct password login)', () => {
    const OLD_EMAIL = 'sync-c-old@test.local';
    const NEW_EMAIL = 'sync-c-new@test.local';
    const PASSWORD = 'SyncCPass@12345';
    let employeeId: string;

    beforeAll(async () => {
      const emp = await createEmployeeWithUser({
        empCode: 'SYNC-C',
        phone: '9911100021',
        email: OLD_EMAIL,
        password: PASSWORD,
      });
      employeeId = emp.id;
    });

    it('admin PUT /employees/:id email edit updates User.email and allows login with the new email', async () => {
      const updateRes = await request(app.getHttpServer())
        .put(`/api/v1/employees/${employeeId}`)
        .set(headers(adminToken))
        .send({ email: NEW_EMAIL })
        .expect(200);
      expect(updateRes.body.success).toBe(true);
      expect(updateRes.body.data.email).toBe(NEW_EMAIL);

      const dbUser = await prisma.user.findFirst({ where: { employeeId } });
      expect(dbUser?.email).toBe(NEW_EMAIL);

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: NEW_EMAIL, password: PASSWORD })
        .expect(200);
      expect(loginRes.body.success).toBe(true);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: OLD_EMAIL, password: PASSWORD })
        .expect(401);
    });
  });

  // ── (d) email collision -> clean 409, no partial write ───────────────────

  describe('(d) admin email edit colliding with another User in the same org -> clean 409', () => {
    const EMP_A_EMAIL = 'sync-d-a@test.local';
    const EMP_B_EMAIL = 'sync-d-b@test.local';
    let employeeAId: string;

    beforeAll(async () => {
      const empA = await createEmployeeWithUser({
        empCode: 'SYNC-D-A',
        phone: '9911100031',
        email: EMP_A_EMAIL,
      });
      employeeAId = empA.id;

      await createEmployeeWithUser({
        empCode: 'SYNC-D-B',
        phone: '9911100032',
        email: EMP_B_EMAIL,
      });
    });

    it('returns a clean 409 (not 500) and leaves Employee A / User A untouched', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/employees/${employeeAId}`)
        .set(headers(adminToken))
        .send({ email: EMP_B_EMAIL })
        .expect(409);
      expect(res.body.success).toBe(false);
      expect(String(res.body.message ?? res.body.error)).toMatch(/already in use/i);

      const dbEmployeeA = await prisma.employee.findUnique({ where: { id: employeeAId } });
      expect(dbEmployeeA?.email).toBe(EMP_A_EMAIL);

      const dbUserA = await prisma.user.findFirst({ where: { employeeId: employeeAId } });
      expect(dbUserA?.email).toBe(EMP_A_EMAIL);
    });
  });

  // ── (e) no-linked-User safety ─────────────────────────────────────────────

  describe('(e) editing phone/email on an employee with no linked User is a safe no-op', () => {
    let employeeId: string;

    beforeAll(async () => {
      const emp = await createEmployeeWithUser({
        empCode: 'SYNC-E',
        phone: '9911100041',
        email: 'sync-e@test.local',
        withUser: false,
      });
      employeeId = emp.id;
    });

    it('admin PUT /employees/:id phone+email edit succeeds with no linked User (no 500)', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/employees/${employeeId}`)
        .set(headers(adminToken))
        .send({ phone: '9911100042', email: 'sync-e-new@test.local' })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe('9911100042');
      expect(res.body.data.email).toBe('sync-e-new@test.local');

      const dbUser = await prisma.user.findFirst({ where: { employeeId } });
      expect(dbUser).toBeNull();
    });
  });
});
