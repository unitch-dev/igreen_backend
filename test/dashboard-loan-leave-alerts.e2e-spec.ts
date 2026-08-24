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
 * GET /dashboards/loan-leave-summary and GET /dashboards/admin-alerts —
 * new Admin Dashboard widgets (table_loan_leave_summary / list_notifications).
 * Covers org-scoping, RBAC gating, and the specific boundary conditions
 * called out in the widget doc comments (onLeaveToday/onLeaveThisWeek date
 * boundaries, onboarding-link 7-day expiry window, ACTIVE-loan outstanding
 * balance modeling).
 */
describe('Dashboards — loan-leave-summary & admin-alerts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdOrgIds: string[] = [];

  const PASSWORD = 'Test@1234';

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

      await prisma.loanEmiSchedule.deleteMany({
        where: { loan: { employeeId: { in: employeeIds } } },
      });
      await prisma.loanApplication.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveApplication.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leavePolicyType.deleteMany({ where: { leavePolicy: { organizationId } } });
      await prisma.leavePolicy.deleteMany({ where: { organizationId } });
      await prisma.serviceRequest.deleteMany({ where: { organizationId } });
      await prisma.todoTask.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.onboardingLink.deleteMany({ where: { organizationId } });
      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.loginHistory.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.employee.deleteMany({ where: { organizationId } });
      await prisma.designation.deleteMany({ where: { organizationId } });
      await prisma.department.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await app.close();
  });

  interface OrgFixture {
    organizationId: string;
    departmentId: string;
    designationId: string;
    employeeId: string;
    leavePolicyTypeId: string;
    fullAccessToken: string;
    loanOnlyToken: string;
    leaveOnlyToken: string;
    noOnboardingToken: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `dashboard-lla-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Dashboard LLA E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const fullAccessRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `dash-lla-full-${label}`,
        permissions: ['loan:read', 'leave:read', 'onboarding:manage'],
        isSystemRole: false,
      },
    });
    const loanOnlyRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `dash-lla-loan-only-${label}`,
        permissions: ['loan:read'],
        isSystemRole: false,
      },
    });
    const leaveOnlyRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `dash-lla-leave-only-${label}`,
        permissions: ['leave:read'],
        isSystemRole: false,
      },
    });
    const noOnboardingRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `dash-lla-no-onboarding-${label}`,
        permissions: ['loan:read', 'leave:read'],
        isSystemRole: false,
      },
    });

    const department = await prisma.department.create({
      data: { organizationId: org.id, name: `Dept ${label}` },
    });
    const designation = await prisma.designation.create({
      data: { organizationId: org.id, departmentId: department.id, name: `Designation ${label}` },
    });

    const leavePolicy = await prisma.leavePolicy.create({
      data: { organizationId: org.id, name: `Leave Policy ${label}` },
    });
    const leavePolicyType = await prisma.leavePolicyType.create({
      data: {
        leavePolicyId: leavePolicy.id,
        leaveType: 'EARNED',
        daysPerYear: 12,
      },
    });

    const employee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `EMP-${label}`,
        firstName: 'Applicant',
        lastName: label,
        phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
        departmentId: department.id,
        designationId: designation.id,
        status: 'ACTIVE',
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    async function makeUser(roleId: string, tag: string): Promise<string> {
      const userEmployee = await prisma.employee.create({
        data: {
          organizationId: org.id,
          empCode: `${tag}-${label}`,
          firstName: tag,
          lastName: label,
          phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
          departmentId: department.id,
          designationId: designation.id,
          status: 'ACTIVE',
        },
      });
      const user = await prisma.user.create({
        data: {
          organizationId: org.id,
          employeeId: userEmployee.id,
          email: `${tag}-${label}@dashboard-lla-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId } });

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);

      return login.body.data.accessToken;
    }

    const fullAccessToken = await makeUser(fullAccessRole.id, 'full');
    const loanOnlyToken = await makeUser(loanOnlyRole.id, 'loanonly');
    const leaveOnlyToken = await makeUser(leaveOnlyRole.id, 'leaveonly');
    const noOnboardingToken = await makeUser(noOnboardingRole.id, 'noonb');

    return {
      organizationId: org.id,
      departmentId: department.id,
      designationId: designation.id,
      employeeId: employee.id,
      leavePolicyTypeId: leavePolicyType.id,
      fullAccessToken,
      loanOnlyToken,
      leaveOnlyToken,
      noOnboardingToken,
    };
  }

  function authed(organizationId: string, token: string) {
    return { Authorization: `Bearer ${token}`, 'X-Organization-ID': organizationId };
  }

  function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  // ─── GET /dashboards/loan-leave-summary ────────────────────────────────────

  describe('GET /dashboards/loan-leave-summary', () => {
    let orgA: OrgFixture;
    let orgB: OrgFixture;

    beforeAll(async () => {
      orgA = await createOrgFixture('lls-a');
      orgB = await createOrgFixture('lls-b');

      // Org A: 2 pending loans (10000 + 25000), 1 active loan with EMI schedule.
      await prisma.loanApplication.create({
        data: { employeeId: orgA.employeeId, amountRequested: 10000, status: 'PENDING' },
      });
      await prisma.loanApplication.create({
        data: { employeeId: orgA.employeeId, amountRequested: 25000, status: 'PENDING' },
      });
      const activeLoan = await prisma.loanApplication.create({
        data: {
          employeeId: orgA.employeeId,
          amountRequested: 60000,
          amountApproved: 60000,
          status: 'ACTIVE',
        },
      });
      // Next undeducted EMI (earliest emiYear/emiMonth) should be the one summed.
      await prisma.loanEmiSchedule.create({
        data: {
          loanId: activeLoan.id,
          emiMonth: 1,
          emiYear: 2026,
          emiAmount: 5500,
          principal: 5000,
          interest: 500,
          outstandingBalance: 55000,
          isDeducted: false,
          dueDate: new Date('2026-01-05'),
        },
      });
      await prisma.loanEmiSchedule.create({
        data: {
          loanId: activeLoan.id,
          emiMonth: 2,
          emiYear: 2026,
          emiAmount: 5500,
          principal: 5100,
          interest: 400,
          outstandingBalance: 49900,
          isDeducted: false,
          dueDate: new Date('2026-02-05'),
        },
      });
      // Already-deducted EMI must be ignored even though it's chronologically earliest.
      await prisma.loanEmiSchedule.create({
        data: {
          loanId: activeLoan.id,
          emiMonth: 12,
          emiYear: 2025,
          emiAmount: 5500,
          principal: 4900,
          interest: 600,
          outstandingBalance: 60000,
          isDeducted: true,
          dueDate: new Date('2025-12-05'),
        },
      });

      // Org A: 1 pending leave, 1 approved leave covering today+this-week,
      // 1 approved leave entirely in the past (must not count), 1 approved
      // leave for next month (must not count), and a duplicate-employee
      // overlapping leave to verify distinct-employee dedup.
      await prisma.leaveApplication.create({
        data: {
          employeeId: orgA.employeeId,
          leavePolicyTypeId: orgA.leavePolicyTypeId,
          fromDate: daysFromNow(10),
          toDate: daysFromNow(12),
          days: 3,
          status: 'PENDING',
        },
      });
      await prisma.leaveApplication.create({
        data: {
          employeeId: orgA.employeeId,
          leavePolicyTypeId: orgA.leavePolicyTypeId,
          fromDate: daysFromNow(-1),
          toDate: daysFromNow(1),
          days: 3,
          status: 'APPROVED',
        },
      });
      // Duplicate overlapping approved leave for the SAME employee — must not
      // double-count onLeaveToday/onLeaveThisWeek (distinct employeeId).
      await prisma.leaveApplication.create({
        data: {
          employeeId: orgA.employeeId,
          leavePolicyTypeId: orgA.leavePolicyTypeId,
          fromDate: daysFromNow(0),
          toDate: daysFromNow(0),
          days: 1,
          status: 'APPROVED',
        },
      });
      await prisma.leaveApplication.create({
        data: {
          employeeId: orgA.employeeId,
          leavePolicyTypeId: orgA.leavePolicyTypeId,
          fromDate: daysFromNow(-30),
          toDate: daysFromNow(-25),
          days: 5,
          status: 'APPROVED',
        },
      });
      await prisma.leaveApplication.create({
        data: {
          employeeId: orgA.employeeId,
          leavePolicyTypeId: orgA.leavePolicyTypeId,
          fromDate: daysFromNow(60),
          toDate: daysFromNow(62),
          days: 3,
          status: 'APPROVED',
        },
      });

      // Org B: different data entirely, to confirm no cross-tenant leakage.
      await prisma.loanApplication.create({
        data: { employeeId: orgB.employeeId, amountRequested: 999999, status: 'PENDING' },
      });
      await prisma.leaveApplication.create({
        data: {
          employeeId: orgB.employeeId,
          leavePolicyTypeId: orgB.leavePolicyTypeId,
          fromDate: daysFromNow(0),
          toDate: daysFromNow(0),
          days: 1,
          status: 'APPROVED',
        },
      });
    });

    it('returns correct org-scoped loan aggregates with no cross-tenant leakage', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboards/loan-leave-summary')
        .set(authed(orgA.organizationId, orgA.fullAccessToken))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.loans.pendingCount).toBe(2);
      expect(res.body.data.loans.pendingAmount).toBe(35000);
      expect(res.body.data.loans.activeCount).toBe(1);
      // Next undeducted EMI is emiYear 2026/emiMonth 1 (55000), NOT the
      // deducted Dec-2025 row and NOT the later Feb-2026 row.
      expect(res.body.data.loans.activeOutstandingAmount).toBe(55000);
    });

    it('returns correct org-scoped leave aggregates including today/week boundaries and dedup', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboards/loan-leave-summary')
        .set(authed(orgA.organizationId, orgA.fullAccessToken))
        .expect(200);

      expect(res.body.data.leave.pendingCount).toBe(1);
      // Two overlapping APPROVED leaves for the same employee both cover
      // today; distinct-employee dedup must collapse this to 1.
      expect(res.body.data.leave.onLeaveToday).toBe(1);
      expect(res.body.data.leave.onLeaveThisWeek).toBe(1);
    });

    it("does not leak org B's loan/leave data into org A's summary", async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboards/loan-leave-summary')
        .set(authed(orgA.organizationId, orgA.fullAccessToken))
        .expect(200);

      expect(res.body.data.loans.pendingAmount).not.toBe(999999 + 35000);
      expect(res.body.data.loans.pendingAmount).toBe(35000);
    });

    it("org B sees only its own data (confirms symmetric isolation, not a one-sided filter)", async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboards/loan-leave-summary')
        .set(authed(orgB.organizationId, orgB.fullAccessToken))
        .expect(200);

      expect(res.body.data.loans.pendingCount).toBe(1);
      expect(res.body.data.loans.pendingAmount).toBe(999999);
      expect(res.body.data.leave.onLeaveToday).toBe(1);
    });

    it('403s a caller missing leave:read even though they have loan:read', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/dashboards/loan-leave-summary')
        .set(authed(orgA.organizationId, orgA.loanOnlyToken))
        .expect(403);
    });

    it('403s a caller missing loan:read even though they have leave:read', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/dashboards/loan-leave-summary')
        .set(authed(orgA.organizationId, orgA.leaveOnlyToken))
        .expect(403);
    });

    it('200s a caller with both loan:read and leave:read', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/dashboards/loan-leave-summary')
        .set(authed(orgA.organizationId, orgA.fullAccessToken))
        .expect(200);
    });
  });

  // ─── GET /dashboards/admin-alerts ──────────────────────────────────────────

  describe('GET /dashboards/admin-alerts', () => {
    let orgA: OrgFixture;
    let orgB: OrgFixture;

    beforeAll(async () => {
      orgA = await createOrgFixture('alerts-a');
      orgB = await createOrgFixture('alerts-b');

      // Expiring within 7 days -> should show up.
      await prisma.onboardingLink.create({
        data: {
          organizationId: orgA.organizationId,
          token: `tok-soon-${uuid()}`,
          email: 'soon@candidate.test',
          phone: '9111111111',
          candidateName: 'Soon Candidate',
          expiresAt: daysFromNow(3),
          status: 'PENDING',
        },
      });
      // Expiring in 10 days -> outside the 7-day window, must NOT show up.
      await prisma.onboardingLink.create({
        data: {
          organizationId: orgA.organizationId,
          token: `tok-far-${uuid()}`,
          email: 'far@candidate.test',
          phone: '9111111112',
          candidateName: 'Far Candidate',
          expiresAt: daysFromNow(10),
          status: 'PENDING',
        },
      });
      // Already EXPIRED status -> must NOT show up even if expiresAt falls
      // within the next 7 days.
      await prisma.onboardingLink.create({
        data: {
          organizationId: orgA.organizationId,
          token: `tok-expired-${uuid()}`,
          email: 'expired@candidate.test',
          phone: '9111111113',
          candidateName: 'Expired Candidate',
          expiresAt: daysFromNow(2),
          status: 'EXPIRED',
        },
      });
      // IN_PROGRESS within window -> should show up too.
      await prisma.onboardingLink.create({
        data: {
          organizationId: orgA.organizationId,
          token: `tok-inprogress-${uuid()}`,
          email: 'inprogress@candidate.test',
          phone: '9111111114',
          candidateName: 'InProgress Candidate',
          expiresAt: daysFromNow(5),
          status: 'IN_PROGRESS',
        },
      });

      // Pending approvals fixtures for org A.
      await prisma.leaveApplication.create({
        data: {
          employeeId: orgA.employeeId,
          leavePolicyTypeId: orgA.leavePolicyTypeId,
          fromDate: daysFromNow(1),
          toDate: daysFromNow(2),
          days: 2,
          status: 'PENDING',
        },
      });
      await prisma.loanApplication.create({
        data: { employeeId: orgA.employeeId, amountRequested: 5000, status: 'PENDING' },
      });
      await prisma.serviceRequest.create({
        data: {
          organizationId: orgA.organizationId,
          employeeId: orgA.employeeId,
          category: 'IT',
          title: 'Laptop issue',
          description: 'Screen flickers',
          status: 'OPEN',
        },
      });
      await prisma.todoTask.create({
        data: { employeeId: orgA.employeeId, title: 'Field visit report', status: 'SUBMITTED' },
      });

      // Org B: a soon-expiring link + its own pending approvals, to confirm isolation.
      await prisma.onboardingLink.create({
        data: {
          organizationId: orgB.organizationId,
          token: `tok-b-soon-${uuid()}`,
          email: 'b-soon@candidate.test',
          phone: '9222222221',
          candidateName: 'Org B Candidate',
          expiresAt: daysFromNow(1),
          status: 'PENDING',
        },
      });
    });

    it('returns only onboarding links expiring within 7 days, excluding EXPIRED and far-future links, org-scoped', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboards/admin-alerts')
        .set(authed(orgA.organizationId, orgA.fullAccessToken))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.onboardingLinksExpiringSoon.count).toBe(2);
      const emails = res.body.data.onboardingLinksExpiringSoon.items.map((i: any) => i.email);
      expect(emails).toContain('soon@candidate.test');
      expect(emails).toContain('inprogress@candidate.test');
      expect(emails).not.toContain('far@candidate.test');
      expect(emails).not.toContain('expired@candidate.test');
      expect(emails).not.toContain('b-soon@candidate.test');

      // Ordered ascending by expiresAt: soon (3d) before inprogress (5d).
      expect(res.body.data.onboardingLinksExpiringSoon.items[0].email).toBe('soon@candidate.test');
    });

    it('returns correct org-scoped pendingApprovals counts', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboards/admin-alerts')
        .set(authed(orgA.organizationId, orgA.fullAccessToken))
        .expect(200);

      expect(res.body.data.pendingApprovals).toEqual({
        leave: 1,
        loan: 1,
        serviceRequest: 1,
        todo: 1,
      });
    });

    it("does not leak org B's onboarding links into org A's alerts", async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboards/admin-alerts')
        .set(authed(orgA.organizationId, orgA.fullAccessToken))
        .expect(200);

      const emails = res.body.data.onboardingLinksExpiringSoon.items.map((i: any) => i.email);
      expect(emails).not.toContain('b-soon@candidate.test');
    });

    it('403s a caller without onboarding:manage', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/dashboards/admin-alerts')
        .set(authed(orgA.organizationId, orgA.noOnboardingToken))
        .expect(403);
    });

    it('200s a caller with onboarding:manage', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/dashboards/admin-alerts')
        .set(authed(orgA.organizationId, orgA.fullAccessToken))
        .expect(200);
    });
  });
});
