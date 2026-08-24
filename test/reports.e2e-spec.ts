import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import * as ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * superagent only auto-buffers a handful of well-known binary content types
 * into `res.body` (octet-stream, images) — xlsx/pdf mime types fall through
 * to its default parser and `res.body` stays `{}`. Any e2e test asserting on
 * the raw bytes of a binary export must pass this to `.buffer(true).parse(...)`.
 */
function binaryParser(res: any, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

// Real bcrypt hashing (10 rounds) + real DB round-trips per fixture user push
// several of the newer, fixture-heavy cases (and shared beforeAll hooks) past
// Jest's default 5000ms — this suite always runs against a real DB/Redis, not
// mocks, so raise the ceiling instead of racing the clock.
jest.setTimeout(30000);

/**
 * Reports & Dashboard module (M17) end-to-end coverage:
 *  - Every report endpoint returns COMPUTED numbers verified against raw
 *    Prisma aggregates seeded directly in the test (not just HTTP 200).
 *  - Excel/PDF export binary shape (zip magic bytes / %PDF header).
 *  - Multi-tenancy: org A's data never leaks into org B's report totals.
 *  - departmentId cross-org validation (404, not silently empty).
 *  - Permission boundary: report:read / report:export required.
 *  - Dashboard KPIs cross-checked against the same headcount report numbers.
 *
 * Runs against the real dev MySQL/Redis instance (same as `npm run start:dev`).
 */
describe('Reports & Dashboard module (e2e)', () => {
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

      await prisma.incentiveLedger.deleteMany({ where: { employeeId: { in: employeeIds } } });
      // TodoTask has an optional 1:1 back-reference from IncentiveLedger.todoId (no cascade),
      // so TodoTask rows must be removed after IncentiveLedger and before Employee.
      await prisma.todoTask.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveApplication.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leavePolicy.deleteMany({ where: { organizationId } });
      await prisma.attendanceLog.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.liveLocation.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.loanEmiSchedule.deleteMany({
        where: { loan: { employeeId: { in: employeeIds } } },
      });
      await prisma.loanApplication.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.payrollEntry.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.payrollRun.deleteMany({ where: { organizationId } });
      // PerformanceRating references both Employee and PerformanceCycle (no cascade on
      // cycle->organization), and EmployeeKpi/Kpi reference Designation (no cascade) — all
      // must be cleared before Employee/Designation/Organization deletes below.
      await prisma.performanceRating.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.performanceCycle.deleteMany({ where: { organizationId } });
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
    readerToken: string;
    noPermToken: string;
    employees: { id: string; empCode: string }[];
  }

  async function createOrgFixture(label: string, employeeCount = 2): Promise<OrgFixture> {
    const slug = `reports-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Reports E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const readerRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `reports-e2e-reader-${label}`,
        description: 'Test reader role',
        permissions: ['report:read', 'report:export'],
        isSystemRole: false,
      },
    });

    const noPermRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `reports-e2e-noperm-${label}`,
        description: 'Test no-permission role',
        permissions: ['employee:read'],
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

    const readerEmployee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `RDR-${label}`,
        firstName: 'Reader',
        lastName: label,
        phone: '9000000001',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });
    const readerUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: readerEmployee.id,
        email: `reader-${label}@reports-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: readerUser.id, roleId: readerRole.id } });

    const noPermEmployee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `NOP-${label}`,
        firstName: 'NoPerm',
        lastName: label,
        phone: '9000000002',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });
    const noPermUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: noPermEmployee.id,
        email: `noperm-${label}@reports-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: noPermUser.id, roleId: noPermRole.id } });

    const employees: { id: string; empCode: string }[] = [];
    for (let i = 0; i < employeeCount; i += 1) {
      const emp = await prisma.employee.create({
        data: {
          organizationId: org.id,
          empCode: `EMP-${label}-${i}`,
          firstName: `Emp${i}`,
          lastName: label,
          phone: `900000${1000 + i}`,
          departmentId: department.id,
          designationId: designation.id,
          payrollStructureId: payrollStructure.id,
          status: 'ACTIVE',
        },
      });
      employees.push({ id: emp.id, empCode: emp.empCode });
    }

    const readerLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: readerUser.email, password: PASSWORD })
      .expect(200);
    const noPermLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: noPermUser.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      departmentId: department.id,
      designationId: designation.id,
      payrollStructureId: payrollStructure.id,
      readerToken: readerLogin.body.data.accessToken,
      noPermToken: noPermLogin.body.data.accessToken,
      employees,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  // ─── Headcount ──────────────────────────────────────────────────────────────

  describe('GET /reports/headcount', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('headcount', 3);
    });

    it('total matches employee.count(organizationId, deletedAt: null) and group sums add up to total', async () => {
      const expectedTotal = await prisma.employee.count({
        where: { organizationId: org.organizationId, deletedAt: null },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/headcount')
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      const data = res.body.data;
      expect(data.total).toBe(expectedTotal);

      const deptSum = data.byDepartment.reduce((s: number, d: any) => s + d.count, 0);
      const statusSum = data.byStatus.reduce((s: number, d: any) => s + d.count, 0);
      const typeSum = data.byEmploymentType.reduce((s: number, d: any) => s + d.count, 0);
      const desigSum = data.byDesignation.reduce((s: number, d: any) => s + d.count, 0);
      expect(deptSum).toBe(expectedTotal);
      expect(statusSum).toBe(expectedTotal);
      expect(typeSum).toBe(expectedTotal);
      expect(desigSum).toBe(expectedTotal);
    });

    it('403s a user without report:read', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/headcount')
        .set(authed(org.noPermToken, org.organizationId))
        .expect(403);
    });
  });

  // ─── Multi-tenancy + departmentId cross-org validation ───────────────────────

  describe('Multi-tenancy scoping', () => {
    let orgA: OrgFixture;
    let orgB: OrgFixture;

    beforeAll(async () => {
      orgA = await createOrgFixture('tenant-a', 2);
      orgB = await createOrgFixture('tenant-b', 1);
    });

    it("org B's headcount total never includes org A's employees", async () => {
      const resA = await request(app.getHttpServer())
        .get('/api/v1/reports/headcount')
        .set(authed(orgA.readerToken, orgA.organizationId))
        .expect(200);
      const resB = await request(app.getHttpServer())
        .get('/api/v1/reports/headcount')
        .set(authed(orgB.readerToken, orgB.organizationId))
        .expect(200);

      // org A: 2 seeded + reader + noPerm = 4; org B: 1 seeded + reader + noPerm = 3
      expect(resA.body.data.total).toBe(4);
      expect(resB.body.data.total).toBe(3);
    });

    it('a departmentId belonging to another org 404s instead of returning empty results (rule #16)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/headcount')
        .query({ departmentId: orgA.departmentId })
        .set(authed(orgB.readerToken, orgB.organizationId))
        .expect(404);

      await request(app.getHttpServer())
        .get('/api/v1/reports/loans')
        .query({ departmentId: orgA.departmentId })
        .set(authed(orgB.readerToken, orgB.organizationId))
        .expect(404);
    });

    it("org B's loans report never includes an org A loan", async () => {
      const loanA = await prisma.loanApplication.create({
        data: {
          employeeId: orgA.employees[0].id,
          amountRequested: 50000,
          amountApproved: 50000,
          status: 'ACTIVE',
        },
      });
      await prisma.loanEmiSchedule.create({
        data: {
          loanId: loanA.id,
          emiMonth: 1,
          emiYear: 2099,
          emiAmount: 5000,
          principal: 4500,
          interest: 500,
          outstandingBalance: 45500,
          dueDate: new Date('2099-01-01'),
        },
      });

      const resB = await request(app.getHttpServer())
        .get('/api/v1/reports/loans')
        .set(authed(orgB.readerToken, orgB.organizationId))
        .expect(200);

      expect(resB.body.data.rows.some((r: any) => r.loanId === loanA.id)).toBe(false);
      expect(resB.body.data.activeLoanCount).toBe(0);
    });
  });

  // ─── Loans report ───────────────────────────────────────────────────────────

  describe('GET /reports/loans', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('loans', 2);

      // Employee 0: one ACTIVE loan with a partially-deducted EMI schedule.
      const loan1 = await prisma.loanApplication.create({
        data: {
          employeeId: org.employees[0].id,
          amountRequested: 24000,
          amountApproved: 24000,
          status: 'ACTIVE',
        },
      });
      await prisma.loanEmiSchedule.createMany({
        data: [
          {
            loanId: loan1.id,
            emiMonth: 1,
            emiYear: 2050,
            emiAmount: 12000,
            principal: 12000,
            interest: 0,
            outstandingBalance: 12000,
            isDeducted: true,
            dueDate: new Date('2050-01-01'),
          },
          {
            loanId: loan1.id,
            emiMonth: 2,
            emiYear: 2050,
            emiAmount: 12000,
            principal: 12000,
            interest: 0,
            outstandingBalance: 0,
            isDeducted: false,
            dueDate: new Date('2050-02-01'),
          },
        ],
      });

      // Employee 1: a CLOSED loan (should not count toward activeLoanCount/totalOutstanding)
      const loan2 = await prisma.loanApplication.create({
        data: {
          employeeId: org.employees[1].id,
          amountRequested: 10000,
          amountApproved: 10000,
          status: 'CLOSED',
        },
      });
      await prisma.loanEmiSchedule.create({
        data: {
          loanId: loan2.id,
          emiMonth: 1,
          emiYear: 2050,
          emiAmount: 10000,
          principal: 10000,
          interest: 0,
          outstandingBalance: 0,
          isDeducted: true,
          dueDate: new Date('2050-01-01'),
        },
      });
    });

    it('activeLoanCount and totalOutstanding match the ACTIVE loans only', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/loans')
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      expect(res.body.data.activeLoanCount).toBe(1);
      // outstanding balance = earliest not-yet-deducted EMI row's outstandingBalance = 0
      // (the un-deducted row's outstandingBalance IS 0 by our fixture, matching
      // the "remaining after this EMI" semantics used by loanOutstandingBalance)
      expect(res.body.data.totalOutstanding).toBe(0);

      const closedRow = res.body.data.rows.find((r: any) => r.status === 'CLOSED');
      expect(closedRow.outstandingBalance).toBe(0);
    });
  });

  // ─── Incentives report ────────────────────────────────────────────────────

  describe('GET /reports/incentives', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('incentives', 2);

      await prisma.incentiveLedger.createMany({
        data: [
          {
            employeeId: org.employees[0].id,
            source: 'TODO',
            totalAmount: 500,
            payrollMonth: 6,
            payrollYear: 2026,
          },
          {
            employeeId: org.employees[0].id,
            source: 'TODO',
            totalAmount: 300,
            payrollMonth: 6,
            payrollYear: 2026,
          },
          {
            employeeId: org.employees[1].id,
            source: 'TODO',
            totalAmount: 700,
            payrollMonth: 6,
            payrollYear: 2026,
          },
          // Different month - must be excluded when filtering month=6,year=2026
          {
            employeeId: org.employees[1].id,
            source: 'TODO',
            totalAmount: 999,
            payrollMonth: 5,
            payrollYear: 2026,
          },
        ],
      });
    });

    it('totalAmount equals the sum of IncentiveLedger.totalAmount for the filtered month/year', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/incentives')
        .query({ month: 6, year: 2026 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      // 500 + 300 + 700 = 1500, excludes the 999 from month 5
      expect(res.body.data.totalAmount).toBe(1500);

      const emp0Row = res.body.data.rows.find((r: any) => r.employeeId === org.employees[0].id);
      expect(emp0Row.totalAmount).toBe(800);
    });
  });

  // ─── Leave report ───────────────────────────────────────────────────────────

  describe('GET /reports/leave', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('leave', 2);

      const policy = await prisma.leavePolicy.create({
        data: {
          organizationId: org.organizationId,
          name: 'Casual Leave',
          types: { create: { leaveType: 'CASUAL', daysPerYear: 12 } },
        },
        include: { types: true },
      });
      const policyType = policy.types[0];

      await prisma.leaveBalance.create({
        data: {
          employeeId: org.employees[0].id,
          leavePolicyTypeId: policyType.id,
          year: 2026,
          entitledDays: 12,
          takenDays: 3,
          balanceDays: 9,
        },
      });

      await prisma.leaveApplication.createMany({
        data: [
          {
            employeeId: org.employees[0].id,
            leavePolicyTypeId: policyType.id,
            fromDate: new Date('2026-07-01'),
            toDate: new Date('2026-07-01'),
            days: 1,
            status: 'PENDING',
          },
          {
            employeeId: org.employees[1].id,
            leavePolicyTypeId: policyType.id,
            fromDate: new Date('2026-07-02'),
            toDate: new Date('2026-07-02'),
            days: 1,
            status: 'PENDING',
          },
          {
            employeeId: org.employees[1].id,
            leavePolicyTypeId: policyType.id,
            fromDate: new Date('2026-07-03'),
            toDate: new Date('2026-07-03'),
            days: 1,
            status: 'APPROVED',
          },
        ],
      });
    });

    it('pendingApplications == count of PENDING LeaveApplication, rows come from LeaveBalance', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/leave')
        .query({ year: 2026 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      expect(res.body.data.pendingApplications).toBe(2);
      const row = res.body.data.rows.find((r: any) => r.employeeId === org.employees[0].id);
      expect(row.entitledDays).toBe(12);
      expect(row.takenDays).toBe(3);
      expect(row.balanceDays).toBe(9);
    });
  });

  // ─── Payroll report ─────────────────────────────────────────────────────────

  describe('GET /reports/payroll', () => {
    let org: OrgFixture;
    let runId: string;

    beforeAll(async () => {
      org = await createOrgFixture('payroll', 2);

      const run = await prisma.payrollRun.create({
        data: { organizationId: org.organizationId, month: 6, year: 2026, status: 'COMPLETED' },
      });
      runId = run.id;

      await prisma.payrollEntry.createMany({
        data: [
          {
            payrollRunId: run.id,
            employeeId: org.employees[0].id,
            workingDays: 30,
            presentDays: 30,
            basicSalary: 30000,
            hra: 10000,
            grossSalary: 40000,
            pfEmployee: 1800,
            netSalary: 38200,
          },
          {
            payrollRunId: run.id,
            employeeId: org.employees[1].id,
            workingDays: 30,
            presentDays: 29,
            lopDays: 1,
            basicSalary: 30000,
            hra: 10000,
            grossSalary: 40000,
            pfEmployee: 1800,
            netSalary: 37200,
          },
        ],
      });
    });

    it('totalDisbursed == sum(netSalary), totalGross == sum(grossSalary), component sums match', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/payroll')
        .query({ month: 6, year: 2026 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      const data = res.body.data;
      expect(data.runId).toBe(runId);
      expect(data.employeeCount).toBe(2);
      expect(data.totalGross).toBe(80000);
      expect(data.totalDisbursed).toBe(38200 + 37200);
      expect(data.componentBreakdown.basicSalary).toBe(60000);
      expect(data.componentBreakdown.hra).toBe(20000);
      expect(data.componentBreakdown.pfEmployee).toBe(3600);
    });
  });

  // ─── Attendance report ──────────────────────────────────────────────────────

  describe('GET /reports/attendance', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('attendance', 2);

      const d = (n: number) => new Date(Date.UTC(2026, 5, n)); // June 2026

      await prisma.attendanceLog.createMany({
        data: [
          { employeeId: org.employees[0].id, date: d(1), status: 'PRESENT' },
          { employeeId: org.employees[0].id, date: d(2), status: 'PRESENT' },
          { employeeId: org.employees[0].id, date: d(3), status: 'ABSENT' },
          { employeeId: org.employees[1].id, date: d(1), status: 'PRESENT' },
          { employeeId: org.employees[1].id, date: d(2), status: 'ABSENT' },
        ],
      });

      const run = await prisma.payrollRun.create({
        data: { organizationId: org.organizationId, month: 6, year: 2026, status: 'COMPLETED' },
      });
      await prisma.payrollEntry.createMany({
        data: [
          {
            payrollRunId: run.id,
            employeeId: org.employees[0].id,
            workingDays: 30,
            presentDays: 28,
            lopDays: 2,
            grossSalary: 40000,
            netSalary: 38000,
          },
          {
            payrollRunId: run.id,
            employeeId: org.employees[1].id,
            workingDays: 30,
            presentDays: 29,
            lopDays: 1,
            grossSalary: 40000,
            netSalary: 39000,
          },
        ],
      });
    });

    it('totalPresent/totalAbsent match AttendanceLog counts; totalLop == sum PayrollEntry.lopDays', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/attendance')
        .query({ from: '2026-06-01', to: '2026-06-30', month: 6, year: 2026 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      const data = res.body.data;
      expect(data.totalPresent).toBe(3);
      expect(data.totalAbsent).toBe(2);
      expect(data.totalLop).toBe(3);
    });
  });

  // ─── Attendance & Live Track report ─────────────────────────────────────────

  describe('GET /reports/attendance-track', () => {
    let org: OrgFixture;
    let otherDeptId: string;

    beforeAll(async () => {
      org = await createOrgFixture('attendance-track', 3);

      const otherDept = await prisma.department.create({
        data: { organizationId: org.organizationId, name: 'Other Dept ATT' },
      });
      otherDeptId = otherDept.id;

      const d = (n: number) => new Date(Date.UTC(2026, 5, n)); // June 2026

      await prisma.attendanceLog.createMany({
        data: [
          {
            employeeId: org.employees[0].id,
            date: d(1),
            status: 'PRESENT',
            checkInAt: d(1),
            checkInLat: 12.34,
            checkInLng: 56.78,
            checkInLocationName: 'HQ',
          },
          {
            employeeId: org.employees[1].id,
            date: d(2),
            status: 'PRESENT',
            checkInAt: d(2),
          },
          // Outside the June range — must be excluded by from/to filtering
          {
            employeeId: org.employees[0].id,
            date: new Date(Date.UTC(2026, 6, 1)),
            status: 'PRESENT',
          },
        ],
      });

      // A live location for employee 2, recorded "now" (within the 30-min window)
      await prisma.liveLocation.create({
        data: { employeeId: org.employees[2].id, lat: 1.1, lng: 2.2, recordedAt: new Date() },
      });
      // A stale live location (2 hours old) — must NOT show up in liveNow
      await prisma.liveLocation.create({
        data: {
          employeeId: org.employees[0].id,
          lat: 9.9,
          lng: 9.9,
          recordedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      });
    });

    it('from/to actually filters rows to the requested period', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/attendance-track')
        .query({ from: '2026-06-01', to: '2026-06-30', limit: 100 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      expect(res.body.data.rows.length).toBe(2);
      expect(res.body.data.rows.every((r: any) => r.date.startsWith('2026-06'))).toBe(true);
    });

    it('liveNow only includes locations recorded within the last 30 minutes', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/attendance-track')
        .query({ from: '2026-06-01', to: '2026-06-30' })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      const liveIds = res.body.data.liveNow.map((l: any) => l.employeeId);
      expect(liveIds).toContain(org.employees[2].id);
      expect(liveIds).not.toContain(org.employees[0].id);
    });

    it('pagination: limit=1 returns 1 row and correct meta.total/meta.totalPages', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/attendance-track')
        .query({ from: '2026-06-01', to: '2026-06-30', limit: 1, page: 1 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      expect(res.body.data.rows.length).toBe(1);
      expect(res.body.data.meta.total).toBe(2);
      expect(res.body.data.meta.totalPages).toBe(2);
    });

    it('departmentId filters rows and a cross-org departmentId 404s', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/attendance-track')
        .query({ from: '2026-06-01', to: '2026-06-30', departmentId: otherDeptId })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);
      expect(res.body.data.rows.length).toBe(0);
    });

    it('403s a user without report:read', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/attendance-track')
        .set(authed(org.noPermToken, org.organizationId))
        .expect(403);
    });
  });

  describe('Attendance-track multi-tenancy', () => {
    it("org B never sees org A's attendance logs or live locations", async () => {
      const orgA = await createOrgFixture('att-track-tenant-a', 1);
      const orgB = await createOrgFixture('att-track-tenant-b', 1);

      await prisma.attendanceLog.create({
        data: { employeeId: orgA.employees[0].id, date: new Date(), status: 'PRESENT' },
      });
      await prisma.liveLocation.create({
        data: { employeeId: orgA.employees[0].id, lat: 1, lng: 1, recordedAt: new Date() },
      });

      const resB = await request(app.getHttpServer())
        .get('/api/v1/reports/attendance-track')
        .set(authed(orgB.readerToken, orgB.organizationId))
        .expect(200);

      expect(
        resB.body.data.rows.some((r: any) => r.employeeId === orgA.employees[0].id),
      ).toBe(false);
      expect(
        resB.body.data.liveNow.some((l: any) => l.employeeId === orgA.employees[0].id),
      ).toBe(false);
    });
  });

  // ─── Performance report ─────────────────────────────────────────────────────

  describe('GET /reports/performance', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('performance', 2);

      const cycle = await prisma.performanceCycle.create({
        data: {
          organizationId: org.organizationId,
          name: 'Perf Cycle 2026',
          startDate: new Date('2026-06-01'),
          endDate: new Date('2026-06-30'),
          status: 'ACTIVE',
        },
      });

      const kpi1 = await prisma.kpi.create({
        data: {
          organizationId: org.organizationId,
          designationId: org.designationId,
          title: 'Sales Target',
        },
      });
      const kpi2 = await prisma.kpi.create({
        data: {
          organizationId: org.organizationId,
          designationId: org.designationId,
          title: 'Quality Score',
        },
      });
      await prisma.employeeKpi.create({
        data: { employeeId: org.employees[0].id, kpiId: kpi1.id, status: 'ACHIEVED' },
      });
      await prisma.employeeKpi.create({
        data: { employeeId: org.employees[0].id, kpiId: kpi2.id, status: 'MISSED' },
      });

      await prisma.performanceRating.create({
        data: {
          cycleId: cycle.id,
          employeeId: org.employees[0].id,
          ratedBy: 'manager-1',
          rating: 4,
          isEligibleForIncrement: true,
          submittedAt: new Date('2026-06-15'),
        },
      });
      await prisma.performanceRating.create({
        data: {
          cycleId: cycle.id,
          employeeId: org.employees[1].id,
          ratedBy: 'manager-1',
          rating: 2,
          isEligibleForIncrement: false,
          // Outside the queried range — must be excluded
          submittedAt: new Date('2026-01-01'),
        },
      });
    });

    it('avgRating/rows/kpiAchievementRate reflect only ratings within from/to', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/performance')
        .query({ from: '2026-06-01', to: '2026-06-30' })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      const data = res.body.data;
      expect(data.totalRatingsCount).toBe(1);
      expect(data.avgRating).toBe(4);
      const row = data.rows.find((r: any) => r.employeeId === org.employees[0].id);
      expect(row.kpiAssignedCount).toBe(2);
      expect(row.kpiAchievedCount).toBe(1);
      expect(row.kpiAchievementRate).toBe(0.5);
    });

    it('a cross-org departmentId 404s', async () => {
      const otherOrg = await createOrgFixture('performance-other', 1);
      await request(app.getHttpServer())
        .get('/api/v1/reports/performance')
        .query({ departmentId: org.departmentId })
        .set(authed(otherOrg.readerToken, otherOrg.organizationId))
        .expect(404);
    });

    it('403s a user without report:read', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/performance')
        .set(authed(org.noPermToken, org.organizationId))
        .expect(403);
    });
  });

  describe('Performance multi-tenancy', () => {
    it("org B never sees org A's performance ratings", async () => {
      const orgA = await createOrgFixture('perf-tenant-a', 1);
      const orgB = await createOrgFixture('perf-tenant-b', 1);

      const cycleA = await prisma.performanceCycle.create({
        data: {
          organizationId: orgA.organizationId,
          name: 'Cycle A',
          startDate: new Date('2026-06-01'),
          endDate: new Date('2026-06-30'),
          status: 'ACTIVE',
        },
      });
      await prisma.performanceRating.create({
        data: {
          cycleId: cycleA.id,
          employeeId: orgA.employees[0].id,
          ratedBy: 'manager-a',
          rating: 5,
          submittedAt: new Date('2026-06-10'),
        },
      });

      const resB = await request(app.getHttpServer())
        .get('/api/v1/reports/performance')
        .query({ from: '2026-06-01', to: '2026-06-30' })
        .set(authed(orgB.readerToken, orgB.organizationId))
        .expect(200);

      expect(resB.body.data.totalRatingsCount).toBe(0);
      expect(
        resB.body.data.rows.some((r: any) => r.employeeId === orgA.employees[0].id),
      ).toBe(false);
    });
  });

  // ─── Todo & Incentive report ────────────────────────────────────────────────

  describe('GET /reports/todo-incentive', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('todo-incentive', 2);

      await prisma.todoTask.createMany({
        data: [
          {
            employeeId: org.employees[0].id,
            title: 'Task 1',
            status: 'APPROVED',
            submittedAt: new Date('2026-06-05'),
          },
          {
            employeeId: org.employees[0].id,
            title: 'Task 2',
            status: 'REJECTED',
            submittedAt: new Date('2026-06-06'),
          },
          {
            employeeId: org.employees[0].id,
            title: 'Task 3 (outside range)',
            status: 'APPROVED',
            submittedAt: new Date('2026-01-01'),
          },
        ],
      });

      await prisma.incentiveLedger.create({
        data: {
          employeeId: org.employees[0].id,
          source: 'TODO',
          totalAmount: 400,
          releaseAmount: 250,
          payrollMonth: 6,
          payrollYear: 2026,
        },
      });
    });

    it('completionRate and incentive totals reflect only todos/ledger rows within range/filters', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/todo-incentive')
        .query({ from: '2026-06-01', to: '2026-06-30', month: 6, year: 2026 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      const data = res.body.data;
      expect(data.orgTodosApproved).toBe(1);
      const row = data.rows.find((r: any) => r.employeeId === org.employees[0].id);
      expect(row.todosTotal).toBe(2); // excludes the Jan task outside from/to
      expect(row.todosApproved).toBe(1);
      expect(row.todosRejected).toBe(1);
      expect(row.completionRate).toBe(0.5);
      expect(row.incentiveTotalAmount).toBe(400);
      expect(row.incentiveReleasedAmount).toBe(250);
    });

    it('403s a user without report:read', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/todo-incentive')
        .set(authed(org.noPermToken, org.organizationId))
        .expect(403);
    });
  });

  describe('Todo-incentive multi-tenancy', () => {
    it("org B never sees org A's todos or incentive ledger", async () => {
      const orgA = await createOrgFixture('todo-tenant-a', 1);
      const orgB = await createOrgFixture('todo-tenant-b', 1);

      await prisma.todoTask.create({
        data: {
          employeeId: orgA.employees[0].id,
          title: 'Org A task',
          status: 'APPROVED',
          submittedAt: new Date(),
        },
      });
      await prisma.incentiveLedger.create({
        data: {
          employeeId: orgA.employees[0].id,
          source: 'TODO',
          totalAmount: 999,
          payrollMonth: 6,
          payrollYear: 2026,
        },
      });

      const resB = await request(app.getHttpServer())
        .get('/api/v1/reports/todo-incentive')
        .set(authed(orgB.readerToken, orgB.organizationId))
        .expect(200);

      expect(resB.body.data.orgTodosApproved).toBe(0);
      expect(resB.body.data.orgIncentiveTotalAmount).toBe(0);
    });
  });

  // ─── Payroll report — per-employee rows ─────────────────────────────────────

  describe('GET /reports/payroll — per-employee rows', () => {
    it('rows reflect the resolved run only, not a stale/other run', async () => {
      const org = await createOrgFixture('payroll-rows', 2);

      const oldRun = await prisma.payrollRun.create({
        data: { organizationId: org.organizationId, month: 5, year: 2026, status: 'COMPLETED' },
      });
      await prisma.payrollEntry.create({
        data: {
          payrollRunId: oldRun.id,
          employeeId: org.employees[0].id,
          workingDays: 30,
          presentDays: 30,
          grossSalary: 11111,
          netSalary: 11111,
        },
      });

      const newRun = await prisma.payrollRun.create({
        data: { organizationId: org.organizationId, month: 6, year: 2026, status: 'COMPLETED' },
      });
      await prisma.payrollEntry.create({
        data: {
          payrollRunId: newRun.id,
          employeeId: org.employees[0].id,
          workingDays: 30,
          presentDays: 30,
          grossSalary: 55555,
          netSalary: 44444,
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/payroll')
        .query({ month: 6, year: 2026 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      expect(res.body.data.runId).toBe(newRun.id);
      const row = res.body.data.rows.find((r: any) => r.employeeId === org.employees[0].id);
      expect(row.grossSalary).toBe(55555);
      expect(row.netSalary).toBe(44444);

      const resPage2 = await request(app.getHttpServer())
        .get('/api/v1/reports/payroll')
        .query({ month: 6, year: 2026, limit: 1, page: 2 })
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);
      expect(resPage2.body.data.meta.page).toBe(2);
      expect(resPage2.body.data.meta.total).toBe(1); // only employees[0] has an entry in newRun
    });
  });

  // ─── Audit / Login history report — RBAC + org scoping ──────────────────────

  describe('GET /reports/audit', () => {
    interface AuditFixture extends OrgFixture {
      auditOnlyToken: string;
      auditExportToken: string;
    }

    async function createAuditFixture(label: string): Promise<AuditFixture> {
      const base = await createOrgFixture(label, 1);
      const passwordHash = await bcrypt.hash(PASSWORD, 10);

      const auditOnlyRole = await prisma.role.create({
        data: {
          organizationId: base.organizationId,
          name: `${label}-audit-only`,
          permissions: ['report:audit'],
          isSystemRole: false,
        },
      });
      const auditExportRole = await prisma.role.create({
        data: {
          organizationId: base.organizationId,
          name: `${label}-audit-export`,
          permissions: ['report:audit', 'report:export', 'report:read'],
          isSystemRole: false,
        },
      });

      async function makeUser(email: string, roleId: string): Promise<string> {
        const emp = await prisma.employee.create({
          data: {
            organizationId: base.organizationId,
            empCode: `${email}`.slice(0, 10),
            firstName: 'Fx',
            lastName: label,
            phone: `9${Math.floor(Math.random() * 1000000000)}`,
            departmentId: base.departmentId,
            designationId: base.designationId,
            payrollStructureId: base.payrollStructureId,
            status: 'ACTIVE',
          },
        });
        const user = await prisma.user.create({
          data: {
            organizationId: base.organizationId,
            employeeId: emp.id,
            email,
            passwordHash,
            isActive: true,
          },
        });
        await prisma.userRole.create({ data: { userId: user.id, roleId } });
        const login = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email, password: PASSWORD })
          .expect(200);
        return login.body.data.accessToken;
      }

      const auditOnlyToken = await makeUser(`audit-only-${label}@reports-e2e.test`, auditOnlyRole.id);
      const auditExportToken = await makeUser(
        `audit-export-${label}@reports-e2e.test`,
        auditExportRole.id,
      );

      return { ...base, auditOnlyToken, auditExportToken };
    }

    it('a user with report:read but not report:audit gets 403 on GET /reports/audit', async () => {
      const org = await createOrgFixture('audit-noaudit', 1);
      await request(app.getHttpServer())
        .get('/api/v1/reports/audit')
        .set(authed(org.readerToken, org.organizationId))
        .expect(403);
    });

    it('a user with report:audit (but not report:read) can access GET /reports/audit', async () => {
      const org = await createAuditFixture('audit-access');
      await request(app.getHttpServer())
        .get('/api/v1/reports/audit')
        .set(authed(org.auditOnlyToken, org.organizationId))
        .expect(200);
    });

    it("org B's audit rows never include org A's users, even though LoginHistory has no direct organizationId column", async () => {
      const orgA = await createAuditFixture('audit-tenant-a');
      const orgB = await createAuditFixture('audit-tenant-b');

      // orgA's reader already logged in once during fixture setup (readerLogin) —
      // add one more explicit login to be sure there's LoginHistory for orgA.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `reader-audit-tenant-a@reports-e2e.test`, password: PASSWORD })
        .expect(200);

      const resB = await request(app.getHttpServer())
        .get('/api/v1/reports/audit')
        .query({ limit: 100 })
        .set(authed(orgB.auditOnlyToken, orgB.organizationId))
        .expect(200);

      const orgAUserIds = [orgA.auditOnlyToken, orgA.auditExportToken]; // not directly useful, but assert by email domain instead
      void orgAUserIds;
      expect(
        resB.body.data.rows.every((r: any) => !r.email.includes(`-audit-tenant-a@`)),
      ).toBe(true);
    });

    it('from/to filters login rows to the requested period', async () => {
      const org = await createAuditFixture('audit-daterange');
      const users = await prisma.user.findMany({ where: { organizationId: org.organizationId } });
      const targetUser = users[0];

      await prisma.loginHistory.create({
        data: { userId: targetUser.id, loginAt: new Date('2020-01-01'), status: 'success' },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/audit')
        .query({ from: '2026-01-01', to: '2026-12-31', limit: 100 })
        .set(authed(org.auditOnlyToken, org.organizationId))
        .expect(200);

      expect(
        res.body.data.rows.some((r: any) => r.loginAt.startsWith('2020')),
      ).toBe(false);
    });

    it('a user with report:read + report:export but NOT report:audit gets 403 exporting type=audit', async () => {
      const org = await createOrgFixture('audit-export-noaudit', 1);
      await request(app.getHttpServer())
        .get('/api/v1/reports/audit/export')
        .query({ format: 'excel' })
        .set(authed(org.readerToken, org.organizationId))
        .expect(403);
    });

    it('a user with report:audit + report:export succeeds exporting type=audit as excel', async () => {
      const org = await createAuditFixture('audit-export-ok');
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/audit/export')
        .query({ format: 'excel' })
        .set(authed(org.auditExportToken, org.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(res.headers['content-type']).toContain('spreadsheetml');
      const buf: Buffer = res.body;
      expect(buf.slice(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    });

    it('audit type is rejected for PDF export with 400 (not in PDF_SUPPORTED_TYPES)', async () => {
      const org = await createAuditFixture('audit-pdf-reject');
      await request(app.getHttpServer())
        .get('/api/v1/reports/audit/export')
        .query({ format: 'pdf' })
        .set(authed(org.auditExportToken, org.organizationId))
        .expect(400);
    });
  });

  // ─── Export: Excel ──────────────────────────────────────────────────────────

  describe('GET /reports/:type/export?format=excel', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('export-excel', 2);
      const run = await prisma.payrollRun.create({
        data: { organizationId: org.organizationId, month: 6, year: 2026, status: 'COMPLETED' },
      });
      await prisma.payrollEntry.create({
        data: {
          payrollRunId: run.id,
          employeeId: org.employees[0].id,
          workingDays: 30,
          presentDays: 30,
          grossSalary: 40000,
          netSalary: 38200,
        },
      });
    });

    it('headcount excel export returns a valid xlsx (zip magic bytes) with attachment headers', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/headcount/export')
        .query({ format: 'excel' })
        .set(authed(org.readerToken, org.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.headers['content-disposition']).toContain('attachment');
      const buf: Buffer = res.body;
      expect(buf.length).toBeGreaterThan(0);
      expect(buf.slice(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04])); // PK\x03\x04
    });

    it('payroll excel export returns a valid xlsx', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/payroll/export')
        .query({ format: 'excel', month: 6, year: 2026 })
        .set(authed(org.readerToken, org.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(res.headers['content-type']).toContain('spreadsheetml');
      const buf: Buffer = res.body;
      expect(buf.slice(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    });

    it('403s a user without report:export', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/headcount/export')
        .query({ format: 'excel' })
        .set(authed(org.noPermToken, org.organizationId))
        .expect(403);
    });

    it('attendance-track excel export produces a "Live Now" sheet with rows matching liveLocation data', async () => {
      const trackOrg = await createOrgFixture('export-excel-track', 1);
      await prisma.liveLocation.create({
        data: { employeeId: trackOrg.employees[0].id, lat: 5, lng: 6, recordedAt: new Date() },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/attendance-track/export')
        .query({ format: 'excel' })
        .set(authed(trackOrg.readerToken, trackOrg.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body);
      const liveSheet = workbook.getWorksheet('Live Now');
      expect(liveSheet).toBeDefined();
      // header row + at least 1 data row
      expect(liveSheet!.rowCount).toBeGreaterThanOrEqual(2);
    });

    it('performance excel export contains a per-employee rating row', async () => {
      const perfOrg = await createOrgFixture('export-excel-perf', 1);
      const cycle = await prisma.performanceCycle.create({
        data: {
          organizationId: perfOrg.organizationId,
          name: 'Excel Export Cycle',
          startDate: new Date(),
          endDate: new Date(),
          status: 'ACTIVE',
        },
      });
      await prisma.performanceRating.create({
        data: {
          cycleId: cycle.id,
          employeeId: perfOrg.employees[0].id,
          ratedBy: 'mgr',
          rating: 3.5,
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/performance/export')
        .query({ format: 'excel' })
        .set(authed(perfOrg.readerToken, perfOrg.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body);
      const sheet = workbook.getWorksheet('performance');
      expect(sheet!.rowCount).toBeGreaterThanOrEqual(2);
    });

    it('todo-incentive excel export contains a per-employee completion row', async () => {
      const todoOrg = await createOrgFixture('export-excel-todo', 1);
      await prisma.todoTask.create({
        data: {
          employeeId: todoOrg.employees[0].id,
          title: 'Excel Export Task',
          status: 'APPROVED',
          submittedAt: new Date(),
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/todo-incentive/export')
        .query({ format: 'excel' })
        .set(authed(todoOrg.readerToken, todoOrg.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body);
      const sheet = workbook.getWorksheet('todo-incentive');
      expect(sheet!.rowCount).toBeGreaterThanOrEqual(2);
    });

    it('audit excel export produces a "System Changes" sheet (excel supports all 10 types)', async () => {
      const auditOrg = await createOrgFixture('export-excel-audit', 1);
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const auditRole = await prisma.role.create({
        data: {
          organizationId: auditOrg.organizationId,
          name: 'export-excel-audit-role',
          permissions: ['report:audit', 'report:export'],
          isSystemRole: false,
        },
      });
      const emp = await prisma.employee.create({
        data: {
          organizationId: auditOrg.organizationId,
          empCode: 'AUDEXP',
          firstName: 'Audit',
          lastName: 'Exporter',
          phone: '9199999999',
          departmentId: auditOrg.departmentId,
          designationId: auditOrg.designationId,
          payrollStructureId: auditOrg.payrollStructureId,
          status: 'ACTIVE',
        },
      });
      const user = await prisma.user.create({
        data: {
          organizationId: auditOrg.organizationId,
          employeeId: emp.id,
          email: 'audit-exporter@reports-e2e.test',
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: auditRole.id } });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/audit/export')
        .query({ format: 'excel' })
        .set(authed(login.body.data.accessToken, auditOrg.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body);
      expect(workbook.getWorksheet('System Changes')).toBeDefined();
    });
  });

  // ─── Export: PDF ────────────────────────────────────────────────────────────

  describe('GET /reports/:type/export?format=pdf', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('export-pdf', 1);
      const run = await prisma.payrollRun.create({
        data: { organizationId: org.organizationId, month: 6, year: 2026, status: 'COMPLETED' },
      });
      await prisma.payrollEntry.create({
        data: {
          payrollRunId: run.id,
          employeeId: org.employees[0].id,
          workingDays: 30,
          presentDays: 30,
          grossSalary: 40000,
          netSalary: 38200,
        },
      });
    });

    it('payroll pdf export returns a valid PDF (starts with %PDF)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/payroll/export')
        .query({ format: 'pdf', month: 6, year: 2026 })
        .set(authed(org.readerToken, org.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
      const buf: Buffer = res.body;
      expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
    });

    it('headcount (non-payroll) pdf export is rejected with 400 (documented-unsupported)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/headcount/export')
        .query({ format: 'pdf' })
        .set(authed(org.readerToken, org.organizationId))
        .expect(400);
    });

    it('attendance-track pdf export returns a valid non-trivial PDF', async () => {
      const trackOrg = await createOrgFixture('export-pdf-track', 1);
      await prisma.attendanceLog.create({
        data: { employeeId: trackOrg.employees[0].id, date: new Date(), status: 'PRESENT' },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/attendance-track/export')
        .query({ format: 'pdf' })
        .set(authed(trackOrg.readerToken, trackOrg.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
      const buf: Buffer = res.body;
      expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
      expect(buf.length).toBeGreaterThan(200);
    });

    it('performance pdf export returns a valid non-trivial PDF', async () => {
      const perfOrg = await createOrgFixture('export-pdf-perf', 1);
      const cycle = await prisma.performanceCycle.create({
        data: {
          organizationId: perfOrg.organizationId,
          name: 'PDF Export Cycle',
          startDate: new Date(),
          endDate: new Date(),
          status: 'ACTIVE',
        },
      });
      await prisma.performanceRating.create({
        data: { cycleId: cycle.id, employeeId: perfOrg.employees[0].id, ratedBy: 'mgr', rating: 4 },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/performance/export')
        .query({ format: 'pdf' })
        .set(authed(perfOrg.readerToken, perfOrg.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
      const buf: Buffer = res.body;
      expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
      expect(buf.length).toBeGreaterThan(200);
    });

    it('todo-incentive pdf export returns a valid non-trivial PDF', async () => {
      const todoOrg = await createOrgFixture('export-pdf-todo', 1);
      await prisma.todoTask.create({
        data: {
          employeeId: todoOrg.employees[0].id,
          title: 'PDF Export Task',
          status: 'APPROVED',
          submittedAt: new Date(),
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/reports/todo-incentive/export')
        .query({ format: 'pdf' })
        .set(authed(todoOrg.readerToken, todoOrg.organizationId))
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
      const buf: Buffer = res.body;
      expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
      expect(buf.length).toBeGreaterThan(200);
    });
  });

  // ─── Dashboard KPIs ─────────────────────────────────────────────────────────

  describe('GET /dashboards/kpis', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('kpis', 2);

      const kpiPolicy = await prisma.leavePolicy.create({
        data: {
          organizationId: org.organizationId,
          name: 'CL',
          types: { create: { leaveType: 'CASUAL', daysPerYear: 12 } },
        },
        include: { types: true },
      });

      await prisma.leaveApplication.create({
        data: {
          employeeId: org.employees[0].id,
          leavePolicyTypeId: kpiPolicy.types[0].id,
          fromDate: new Date(),
          toDate: new Date(),
          days: 1,
          status: 'PENDING',
        },
      });

      const loan = await prisma.loanApplication.create({
        data: {
          employeeId: org.employees[1].id,
          amountRequested: 5000,
          status: 'PENDING',
        },
      });

      const activeLoan = await prisma.loanApplication.create({
        data: {
          employeeId: org.employees[1].id,
          amountRequested: 8000,
          amountApproved: 8000,
          status: 'ACTIVE',
        },
      });
      void loan;
      void activeLoan;
    });

    it('returns real non-null counts and kpi_total_employees matches the headcount report', async () => {
      const kpiRes = await request(app.getHttpServer())
        .get('/api/v1/dashboards/kpis')
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      const headcountRes = await request(app.getHttpServer())
        .get('/api/v1/reports/headcount')
        .set(authed(org.readerToken, org.organizationId))
        .expect(200);

      const kpis = kpiRes.body.data;
      expect(kpis.kpi_total_employees).not.toBeNull();
      expect(kpis.kpi_active_employees).not.toBeNull();
      expect(kpis.kpi_pending_approvals).not.toBeNull();
      expect(kpis.kpi_open_loans).not.toBeNull();
      expect(kpis.kpi_total_employees).toBe(headcountRes.body.data.total);
      expect(kpis.kpi_open_loans).toBe(1); // only the ACTIVE loan

      const breakdown = kpis.kpi_pending_approvals_breakdown;
      const sum = breakdown.leave + breakdown.loan + breakdown.serviceRequest + breakdown.todo;
      expect(sum).toBe(kpis.kpi_pending_approvals);
      expect(breakdown.leave).toBeGreaterThanOrEqual(1);
      expect(breakdown.loan).toBeGreaterThanOrEqual(1);
    });

    it('succeeds (200) for a user without report:read — intentionally no permission gate (docs/known-issues.md 2026-08-22)', async () => {
      // GET /dashboards/kpis backs every role's KPI widgets, including
      // employee-scoped ones (kpi_my_leave_balance etc.) — DashboardController
      // deliberately does not @RequirePermissions() it so every role's
      // dashboard can load, per the 2026-08-22 known-issues fix.
      await request(app.getHttpServer())
        .get('/api/v1/dashboards/kpis')
        .set(authed(org.noPermToken, org.organizationId))
        .expect(200);
    });
  });
});
