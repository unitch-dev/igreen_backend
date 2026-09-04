import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { PayrollService } from '../src/modules/payroll/payroll.service';

/**
 * Green Thanks module (M12) end-to-end coverage:
 *  - Quarterly-limit enforcement (send within/over the org's quarterlyLimitPoints).
 *  - Full pipeline: send -> approve -> payroll gross (greenThanksAmount).
 *  - Idempotency: re-running processRun for the same period does not
 *    double-count/reset greenThanksAmount (analogous to loans/incentives).
 *  - Guard rails: non-pending rows can't be re-approved; self-thanks rejected;
 *    config GET auto-creates a singleton on first read.
 *  - Multi-tenancy: a second org's data never leaks into the first org's list.
 *
 * Runs against the real dev MySQL/Redis instance (same as `npm run start:dev`).
 */
describe('Green Thanks module (e2e)', () => {
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

      await prisma.greenThanks.deleteMany({ where: { fromEmployeeId: { in: employeeIds } } });
      await prisma.greenThanksConfig.deleteMany({ where: { organizationId } });
      await prisma.payrollEntry.deleteMany({ where: { employeeId: { in: employeeIds } } });
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

  interface OrgFixture {
    organizationId: string;
    approverToken: string;
    senderUserId: string;
    senderId: string;
    senderToken: string;
    receiverId: string;
    receiverToken: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `green-thanks-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Green Thanks E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const approverRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `gt-e2e-approver-${label}`,
        description: 'Test approver role',
        permissions: [
          'profile:read',
          'leave:approve',
          'payroll:read',
          'payroll:run',
          'green_thanks:read',
          'green_thanks:create',
          'green_thanks:manage',
        ],
        isSystemRole: false,
      },
    });

    const employeeRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `gt-e2e-employee-${label}`,
        description:
          'Test employee role (profile:read + green_thanks:read/create, no leave:approve)',
        permissions: ['profile:read', 'green_thanks:read', 'green_thanks:create'],
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
        components: {
          basic: 30000,
          hra: 10000,
          specialAllowance: 0,
          educationAllowance: 0,
          travelAllowance: 0,
          otherAllowances: 0,
        },
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const approverEmployee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `APR-${label}`,
        firstName: 'Approver',
        lastName: label,
        phone: '9100000001',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });
    const approverUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: approverEmployee.id,
        email: `approver-${label}@gt-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: approverUser.id, roleId: approverRole.id } });

    const sender = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `SND-${label}`,
        firstName: 'Sender',
        lastName: label,
        phone: '9100000002',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });
    const senderUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: sender.id,
        email: `sender-${label}@gt-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: senderUser.id, roleId: employeeRole.id } });

    const receiver = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `RCV-${label}`,
        firstName: 'Receiver',
        lastName: label,
        phone: '9100000003',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });
    const receiverUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: receiver.id,
        email: `receiver-${label}@gt-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: receiverUser.id, roleId: employeeRole.id } });

    const approverLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: approverUser.email, password: PASSWORD })
      .expect(200);
    const senderLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: senderUser.email, password: PASSWORD })
      .expect(200);
    const receiverLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: receiverUser.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      approverToken: approverLogin.body.data.accessToken,
      senderUserId: senderUser.id,
      senderId: sender.id,
      senderToken: senderLogin.body.data.accessToken,
      receiverId: receiver.id,
      receiverToken: receiverLogin.body.data.accessToken,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  async function setConfig(org: OrgFixture, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .put('/api/v1/green-thanks/config')
      .set(authed(org.approverToken, org.organizationId))
      .send(body)
      .expect(200);
  }

  // ─── QUARTERLY LIMIT ────────────────────────────────────────────────────

  describe('Quarterly-limit enforcement', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('quarterly-limit');
      await setConfig(org, { quarterlyLimitPoints: 15, inrPerPoint: 20 });
    });

    it('a send within the limit succeeds (201)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: 10, reason: 'Great teamwork' })
        .expect(201);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.points).toBe(10);
    });

    it('a send that would exceed the cumulative quarter total is rejected (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: 10, reason: 'Another big help' })
        .expect(400);
      expect(res.body.message).toMatch(/quarterly/i);
    });

    it('a send exactly at the remaining limit succeeds (201)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: 5, reason: 'Exactly at the limit' })
        .expect(201);
    });
  });

  // ─── FULL PIPELINE: SEND -> APPROVE -> PAYROLL ────────────────────────────

  describe('Approval -> conversion -> payroll pipeline', () => {
    let org: OrgFixture;
    let greenThanksId: string;
    let payrollMonth: number;
    let payrollYear: number;
    const POINTS = 8;
    const INR_PER_POINT = 25;
    const totalAmount = POINTS * INR_PER_POINT;

    beforeAll(async () => {
      org = await createOrgFixture('pipeline');
      await setConfig(org, { inrPerPoint: INR_PER_POINT, quarterlyLimitPoints: 1000 });

      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: POINTS, reason: 'Helped ship the release' })
        .expect(201);
      greenThanksId = sendRes.body.data.id;

      const now = new Date();
      payrollMonth = now.getMonth() + 1;
      payrollYear = now.getFullYear();
    });

    it('approve sets status=approved, payrollMonth/Year, awardedAt', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${greenThanksId}/approve`)
        .set(authed(org.approverToken, org.organizationId))
        .send({ approve: true, payrollMonth, payrollYear })
        .expect(200);

      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.payrollMonth).toBe(payrollMonth);
      expect(res.body.data.payrollYear).toBe(payrollYear);
      expect(res.body.data.awardedAt).not.toBeNull();
      expect(res.body.data.isPaid).toBe(false);
    });

    it('running payroll for that month/year converts points to INR and includes it in grossSalary', async () => {
      const runRes = await request(app.getHttpServer())
        .post('/api/v1/payroll/runs')
        .set(authed(org.approverToken, org.organizationId))
        .send({ month: payrollMonth, year: payrollYear, employeeIds: [org.receiverId] })
        .expect(201);
      expect(runRes.body.data.status).toBe('COMPLETED');
      const runId = runRes.body.data.id;

      const entryRes = await request(app.getHttpServer())
        .get(`/api/v1/payroll/runs/${runId}/entries/${org.receiverId}`)
        .set(authed(org.approverToken, org.organizationId))
        .expect(200);

      const entry = entryRes.body.data;
      expect(entry.greenThanksAmount).toBe(totalAmount);
      // gross = basic(30000) + hra(10000) + greenThanks(200)
      expect(entry.grossSalary).toBe(30000 + 10000 + totalAmount);

      const gt = await prisma.greenThanks.findUnique({ where: { id: greenThanksId } });
      expect(gt?.isPaid).toBe(true);
    });

    // ─── IDEMPOTENCY RE-RUN ─────────────────────────────────────────────────

    it('re-running processRun for the SAME period leaves greenThanksAmount unchanged (not doubled, not reset)', async () => {
      const runBefore = await request(app.getHttpServer())
        .get('/api/v1/payroll/runs')
        .set(authed(org.approverToken, org.organizationId))
        .query({ month: payrollMonth, year: payrollYear })
        .expect(200);
      const runId = runBefore.body.data.data.find(
        (run: any) => run.month === payrollMonth && run.year === payrollYear,
      ).id;

      const payrollService = app.get(PayrollService);
      await payrollService.processRun(org.organizationId, runId, [org.receiverId]);

      const entryRes = await request(app.getHttpServer())
        .get(`/api/v1/payroll/runs/${runId}/entries/${org.receiverId}`)
        .set(authed(org.approverToken, org.organizationId))
        .expect(200);

      expect(entryRes.body.data.greenThanksAmount).toBe(totalAmount);
      expect(entryRes.body.data.grossSalary).toBe(30000 + 10000 + totalAmount);

      const greenThanksService = (payrollService as any).greenThanksService;
      const gtPeriod = await greenThanksService.getApprovedGreenThanksForPeriod(
        org.organizationId,
        org.receiverId,
        payrollMonth,
        payrollYear,
      );
      expect(gtPeriod).toEqual({ totalAmount: 0, greenThanksIds: [] });
    });
  });

  // ─── GUARD RAILS ──────────────────────────────────────────────────────────

  describe('Guard rails', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('guard-rails');
    });

    it('self-thanks (toEmployeeId == sender) is rejected (400)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.senderId, points: 5, reason: 'Thanking myself' })
        .expect(400);
      expect(res.body.message).toMatch(/yourself/i);
    });

    it('an approved (non-pending) row cannot be approved/rejected again (400)', async () => {
      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: 5, reason: 'For the guard-rail test' })
        .expect(201);
      const id = sendRes.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${id}/approve`)
        .set(authed(org.approverToken, org.organizationId))
        .send({ approve: true })
        .expect(200);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${id}/approve`)
        .set(authed(org.approverToken, org.organizationId))
        .send({ approve: true })
        .expect(400);
      expect(res.body.message).toMatch(/pending/i);
    });

    it('a rejected row cannot be approved (400)', async () => {
      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: 3, reason: 'To be rejected' })
        .expect(201);
      const id = sendRes.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${id}/approve`)
        .set(authed(org.approverToken, org.organizationId))
        .send({ approve: false, rejectionNote: 'Not eligible' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${id}/approve`)
        .set(authed(org.approverToken, org.organizationId))
        .send({ approve: true })
        .expect(400);
      expect(res.body.message).toMatch(/pending/i);
    });

    it('a non-privileged (no leave:approve) user gets 403 on approve', async () => {
      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: 2, reason: 'Perm test' })
        .expect(201);
      const id = sendRes.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${id}/approve`)
        .set(authed(org.receiverToken, org.organizationId))
        .send({ approve: true })
        .expect(403);
    });

    it('GET /green-thanks/config auto-creates a singleton with schema defaults on first read', async () => {
      const freshOrg = await createOrgFixture('config-autocreate');

      const before = await prisma.greenThanksConfig.findFirst({
        where: { organizationId: freshOrg.organizationId },
      });
      expect(before).toBeNull();

      const res = await request(app.getHttpServer())
        .get('/api/v1/green-thanks/config')
        .set(authed(freshOrg.approverToken, freshOrg.organizationId))
        .expect(200);

      expect(res.body.data.inrPerPoint).toBe(50);
      expect(res.body.data.quarterlyLimitPoints).toBe(100);
      expect(res.body.data.isPayrollLinked).toBe(true);

      const after = await prisma.greenThanksConfig.findFirst({
        where: { organizationId: freshOrg.organizationId },
      });
      expect(after).not.toBeNull();

      // Second read returns the SAME row (does not create a duplicate singleton)
      await request(app.getHttpServer())
        .get('/api/v1/green-thanks/config')
        .set(authed(freshOrg.approverToken, freshOrg.organizationId))
        .expect(200);
      const count = await prisma.greenThanksConfig.count({
        where: { organizationId: freshOrg.organizationId },
      });
      expect(count).toBe(1);
    });
  });

  // ─── MULTI-TENANCY SCOPING ─────────────────────────────────────────────────

  describe('Organization scoping', () => {
    it('a GreenThanks row created in org A is never visible from org B', async () => {
      const orgA = await createOrgFixture('tenant-a');
      const orgB = await createOrgFixture('tenant-b');

      await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(orgA.senderToken, orgA.organizationId))
        .send({ toEmployeeId: orgA.receiverId, points: 4, reason: 'Org A only' })
        .expect(201);

      const orgBList = await request(app.getHttpServer())
        .get('/api/v1/green-thanks')
        .set(authed(orgB.approverToken, orgB.organizationId))
        .expect(200);

      expect(orgBList.body.data.data.every((row: any) => row.reason !== 'Org A only')).toBe(true);
      expect(orgBList.body.data.data.length).toBe(0);

      const orgAList = await request(app.getHttpServer())
        .get('/api/v1/green-thanks')
        .set(authed(orgA.approverToken, orgA.organizationId))
        .expect(200);
      expect(orgAList.body.data.data.some((row: any) => row.reason === 'Org A only')).toBe(true);
    });
  });

  // ─── MAKER-CHECKER: SELF-APPROVAL GUARD (hrms-backend.md §26) ─────────────

  describe('Maker-checker: self-approval guard (both sender AND receiver blocked)', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('self-approval');

      // Grant BOTH the sender's and receiver's own users green_thanks:manage
      // too, then re-login each to pick up the newly-flattened permission.
      const approverRole = await prisma.role.findFirstOrThrow({
        where: { organizationId: org.organizationId, name: 'gt-e2e-approver-self-approval' },
      });
      await prisma.userRole.create({
        data: { userId: org.senderUserId, roleId: approverRole.id },
      });
      const senderUser = await prisma.user.findFirstOrThrow({
        where: { organizationId: org.organizationId, employeeId: org.senderId },
      });
      const receiverUser = await prisma.user.findFirstOrThrow({
        where: { organizationId: org.organizationId, employeeId: org.receiverId },
      });
      await prisma.userRole.create({
        data: { userId: receiverUser.id, roleId: approverRole.id },
      });

      const senderRelogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: senderUser.email, password: PASSWORD })
        .expect(200);
      const receiverRelogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: receiverUser.email, password: PASSWORD })
        .expect(200);

      org = {
        ...org,
        senderToken: senderRelogin.body.data.accessToken,
        receiverToken: receiverRelogin.body.data.accessToken,
      };
    });

    it('the SENDER, even holding green_thanks:manage, gets 403 approving an entry they sent', async () => {
      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: 3, reason: 'Sender self-approve attempt' })
        .expect(201);
      const id = sendRes.body.data.id;

      const res = await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${id}/approve`)
        .set(authed(org.senderToken, org.organizationId))
        .send({ approve: true })
        .expect(403);
      expect(res.body.message).toMatch(/sent|receiv/i);
    });

    it('the RECEIVER, even holding green_thanks:manage, gets 403 approving an entry sent to them', async () => {
      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({
          toEmployeeId: org.receiverId,
          points: 3,
          reason: 'Receiver self-approve attempt',
        })
        .expect(201);
      const id = sendRes.body.data.id;

      const res = await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${id}/approve`)
        .set(authed(org.receiverToken, org.organizationId))
        .send({ approve: true })
        .expect(403);
      expect(res.body.message).toMatch(/sent|receiv/i);
    });

    it('a DIFFERENT user holding green_thanks:manage can approve the same entry normally', async () => {
      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(org.senderToken, org.organizationId))
        .send({ toEmployeeId: org.receiverId, points: 3, reason: 'Approved by a third party' })
        .expect(201);
      const id = sendRes.body.data.id;

      const res = await request(app.getHttpServer())
        .put(`/api/v1/green-thanks/${id}/approve`)
        .set(authed(org.approverToken, org.organizationId))
        .send({ approve: true })
        .expect(200);
      expect(res.body.data.status).toBe('approved');
    });
  });

  // ─── SEEDED ADMIN REGRESSION (docs/known-issues.md 2026-08-28) ────────────
  //
  // Before prisma/seed.ts::seedAdminEmployee, admin@igreentec.in had
  // employeeId: null, which tripped the "No employee record found for the
  // current user" guard on every send. The fix links the seeded admin to a
  // real Employee (ADMIN-0001); these tests confirm sending now works while
  // the self-send/recipient-not-found guards remain intact.
  describe('Seeded admin@igreentec.in account (now linked to a real employee)', () => {
    let adminToken: string;
    let adminOrgId: string;
    let adminEmployeeId: string;
    let otherEmployeeId: string;
    const createdIds: string[] = [];

    beforeAll(async () => {
      const adminUser = await prisma.user.findFirst({ where: { email: 'admin@igreentec.in' } });
      if (!adminUser)
        throw new Error('Seeded admin@igreentec.in not found — run the seeders first');
      if (!adminUser.employeeId) {
        throw new Error(
          'Seeded admin@igreentec.in has no employeeId — run `npm run prisma:seed` to apply the ' +
            'seedAdminEmployee fix before running this suite.',
        );
      }
      adminOrgId = adminUser.organizationId;
      adminEmployeeId = adminUser.employeeId;

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'admin@igreentec.in', password: 'Admin@1234' })
        .expect(200);
      adminToken = login.body.data.accessToken;

      const anotherEmployee = await prisma.employee.findFirst({
        where: {
          organizationId: adminOrgId,
          status: 'ACTIVE',
          deletedAt: null,
          id: { not: adminEmployeeId },
        },
        select: { id: true },
      });
      if (!anotherEmployee) {
        throw new Error(
          'No other active employee found in the seeded iGreen org to send thanks to',
        );
      }
      otherEmployeeId = anotherEmployee.id;

      // Keep this well within the org's quarterly limit regardless of what
      // else has already been sent this quarter in shared dev-DB state.
      const existingConfig = await prisma.greenThanksConfig.findFirst({
        where: { organizationId: adminOrgId },
      });
      if (existingConfig) {
        await prisma.greenThanksConfig.update({
          where: { id: existingConfig.id },
          data: { quarterlyLimitPoints: 100000 },
        });
      } else {
        await prisma.greenThanksConfig.create({
          data: {
            organizationId: adminOrgId,
            quarterlyLimitPoints: 100000,
            effectiveFrom: new Date(),
          },
        });
      }
    });

    afterAll(async () => {
      if (createdIds.length) {
        await prisma.greenThanks.deleteMany({ where: { id: { in: createdIds } } });
      }
    });

    it('POST /green-thanks to a real different employee no longer 400s with "No employee record found"', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(adminToken, adminOrgId))
        .send({ toEmployeeId: otherEmployeeId, points: 1, reason: 'Admin regression check' })
        .expect(201);
      createdIds.push(res.body.data.id);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.fromEmployeeId).toBe(adminEmployeeId);
    });

    it('self-send (admin sending to their own now-existing employeeId) still 400s', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(adminToken, adminOrgId))
        .send({ toEmployeeId: adminEmployeeId, points: 1, reason: 'Thanking myself' })
        .expect(400);
      expect(res.body.message).toMatch(/yourself/i);
    });

    it('sending to a non-existent recipient still 404s', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/green-thanks')
        .set(authed(adminToken, adminOrgId))
        .send({ toEmployeeId: uuid(), points: 1, reason: 'Nonexistent recipient' })
        .expect(404);
      expect(res.body.message).toMatch(/not found/i);
    });
  });
});
