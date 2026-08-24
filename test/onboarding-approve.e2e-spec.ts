import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * "Approve & Activate" onboarding dialog — backend boundary verification.
 * Covers testing-agent cases #1 (happy path: real Employee + User created,
 * link -> ACTIVATED, employeeId set) and #4 (backend validation surfaces the
 * real message for an inactive leave policy / mismatched designation).
 */
describe('Onboarding approve (HR) — POST /onboarding-links/:id/approve (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let onboardingQueue: Queue;
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
    onboardingQueue = app.get(getQueueToken('onboarding'));
    jest.spyOn(onboardingQueue, 'add').mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    for (const organizationId of createdOrgIds) {
      await prisma.onboardingTransition.deleteMany({
        where: { onboardingLink: { organizationId } },
      });
      await prisma.onboardingLink.deleteMany({ where: { organizationId } });
      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.employee.deleteMany({ where: { organizationId } });
      await prisma.leavePolicy.deleteMany({ where: { organizationId } });
      await prisma.payrollStructure.deleteMany({ where: { organizationId } });
      await prisma.designation.deleteMany({ where: { organizationId } });
      await prisma.department.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await app.close();
  });

  interface OrgFixture {
    organizationId: string;
    hrToken: string;
    departmentId: string;
    designationId: string;
    otherDepartmentDesignationId: string;
    payrollStructureId: string;
    leavePolicyId: string;
    secondLeavePolicyId: string;
    inactiveLeavePolicyId: string;
    roleId: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `onboarding-approve-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Onboarding Approve E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const hrRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `onboarding-approve-e2e-hr-${label}`,
        permissions: ['employee:read', 'employee:create', 'employee:update', 'employee:delete'],
        isSystemRole: false,
      },
    });

    const assignableRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `onboarding-approve-e2e-employee-${label}`,
        permissions: ['self:read'],
        isSystemRole: false,
      },
    });

    const department = await prisma.department.create({
      data: { organizationId: org.id, name: `Dept ${label}` },
    });
    const designation = await prisma.designation.create({
      data: { organizationId: org.id, departmentId: department.id, name: `Designation ${label}` },
    });

    const otherDepartment = await prisma.department.create({
      data: { organizationId: org.id, name: `Other Dept ${label}` },
    });
    const otherDepartmentDesignation = await prisma.designation.create({
      data: {
        organizationId: org.id,
        departmentId: otherDepartment.id,
        name: `Other Designation ${label}`,
      },
    });

    const payrollStructure = await prisma.payrollStructure.create({
      data: {
        organizationId: org.id,
        name: `Payroll ${label}`,
        components: { basic: 50, hra: 20 },
        isActive: true,
      },
    });

    const leavePolicy = await prisma.leavePolicy.create({
      data: {
        organizationId: org.id,
        name: `Leave Policy ${label}`,
        isActive: true,
        types: { create: { leaveType: 'EARNED', daysPerYear: 12 } },
      },
    });

    const secondLeavePolicy = await prisma.leavePolicy.create({
      data: {
        organizationId: org.id,
        name: `Second Leave Policy ${label}`,
        isActive: true,
        types: { create: { leaveType: 'CASUAL', daysPerYear: 8 } },
      },
    });

    const inactiveLeavePolicy = await prisma.leavePolicy.create({
      data: {
        organizationId: org.id,
        name: `Inactive Leave Policy ${label}`,
        isActive: false,
        types: { create: { leaveType: 'EARNED', daysPerYear: 12 } },
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const hrEmployee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `HR-${label}`,
        firstName: 'HR',
        lastName: label,
        phone: '9300000001',
        departmentId: department.id,
        designationId: designation.id,
        status: 'ACTIVE',
      },
    });
    const hrUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: hrEmployee.id,
        email: `hr-${label}@onboarding-approve-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: hrUser.id, roleId: hrRole.id } });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: hrUser.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      hrToken: login.body.data.accessToken,
      departmentId: department.id,
      designationId: designation.id,
      otherDepartmentDesignationId: otherDepartmentDesignation.id,
      payrollStructureId: payrollStructure.id,
      leavePolicyId: leavePolicy.id,
      secondLeavePolicyId: secondLeavePolicy.id,
      inactiveLeavePolicyId: inactiveLeavePolicy.id,
      roleId: assignableRole.id,
    };
  }

  function authed(org: OrgFixture) {
    return {
      Authorization: `Bearer ${org.hrToken}`,
      'X-Organization-ID': org.organizationId,
    };
  }

  const inviteBody = (overrides: Record<string, unknown> = {}) => ({
    email: `candidate-${uuid()}@example.com`,
    phone: '9876543210',
    candidateName: 'Priya Sharma',
    jobTitle: 'Rig Operator',
    departmentName: 'Operations',
    workLocation: 'Mumbai Offshore',
    ...overrides,
  });

  /** Fast-forwards a freshly created link straight to UNDER_REVIEW with a
   * completed submission, bypassing the multi-step candidate flow (file
   * upload requires live MinIO) — mirrors the direct-status-write pattern
   * already used in onboarding-links.e2e-spec.ts #4. */
  async function forceUnderReview(linkId: string) {
    await prisma.onboardingLink.update({
      where: { id: linkId },
      data: {
        status: 'UNDER_REVIEW',
        submissionData: {
          completedSteps: ['details', 'documents'],
          details: {
            firstName: 'Priya',
            lastName: 'Sharma',
            dateOfBirth: '1995-04-12',
            gender: 'FEMALE',
            nationality: 'Indian',
            bankName: 'HDFC Bank',
            accountNumber: '123456789012',
            ifscCode: 'HDFC0001234',
            accountType: 'SAVINGS',
            declarationAccepted: true,
          },
          documents: [
            {
              type: 'aadhar',
              fileName: 'a.pdf',
              fileUrl: 's3://x',
              uploadedAt: new Date().toISOString(),
            },
          ],
        },
      },
    });
  }

  const approveBody = (org: OrgFixture, overrides: Record<string, unknown> = {}) => ({
    departmentId: org.departmentId,
    designationId: org.designationId,
    roleIds: [org.roleId],
    payrollStructureId: org.payrollStructureId,
    leavePolicyIds: [org.leavePolicyId],
    employmentType: 'FULL_TIME',
    // Deliberately in the past relative to "today" so the service's
    // joiningDate <= now ? ACTIVE : PRE_BOARDING branch resolves to ACTIVE —
    // asserting the happy path actually activates the employee immediately.
    joiningDate: '2026-01-01',
    ...overrides,
  });

  describe('#1 — happy path', () => {
    it('creates a real Employee + User, activates the link, and sets employeeId', async () => {
      const org = await createOrgFixture('happy');
      const created = await request(app.getHttpServer())
        .post('/api/v1/onboarding-links')
        .set(authed(org))
        .send(inviteBody())
        .expect(201);
      const linkId = created.body.data.id;
      await forceUnderReview(linkId);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/onboarding-links/${linkId}/approve`)
        .set(authed(org))
        .send(approveBody(org))
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.activated).toBe(true);
      expect(res.body.data.employeeId).toBeTruthy();
      expect(res.body.data.userId).toBeTruthy();

      // Real Employee row exists, correctly scoped and linked.
      const employee = await prisma.employee.findFirst({
        where: { id: res.body.data.employeeId, organizationId: org.organizationId },
      });
      expect(employee).toBeTruthy();
      expect(employee?.firstName).toBe('Priya');
      expect(employee?.departmentId).toBe(org.departmentId);
      expect(employee?.status).toBe('ACTIVE');

      // Real User row exists, correctly linked to the employee.
      const user = await prisma.user.findFirst({
        where: { id: res.body.data.userId, organizationId: org.organizationId },
      });
      expect(user).toBeTruthy();
      expect(user?.employeeId).toBe(res.body.data.employeeId);

      // GET /employees also surfaces the new employee (list-level confirmation).
      const listRes = await request(app.getHttpServer())
        .get('/api/v1/employees')
        .set(authed(org))
        .expect(200);
      const ids = listRes.body.data.data.map((e: { id: string }) => e.id);
      expect(ids).toContain(res.body.data.employeeId);

      // Link transitioned UNDER_REVIEW -> ACTIVATED with employeeId set.
      const linkRes = await request(app.getHttpServer())
        .get(`/api/v1/onboarding-links/${linkId}`)
        .set(authed(org))
        .expect(200);
      expect(linkRes.body.data.status).toBe('ACTIVATED');
      expect(linkRes.body.data.employeeId).toBe(res.body.data.employeeId);
    });

    it('initializes a LeaveBalance row for EVERY selected leave policy, and sets the primary Employee.leavePolicyId to the first id', async () => {
      const org = await createOrgFixture('multi-leave');
      const created = await request(app.getHttpServer())
        .post('/api/v1/onboarding-links')
        .set(authed(org))
        .send(inviteBody())
        .expect(201);
      const linkId = created.body.data.id;
      await forceUnderReview(linkId);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/onboarding-links/${linkId}/approve`)
        .set(authed(org))
        .send(
          approveBody(org, {
            leavePolicyIds: [org.leavePolicyId, org.secondLeavePolicyId],
          }),
        )
        .expect(200);

      const employeeId = res.body.data.employeeId;

      // Primary policy = first id in the array.
      const employee = await prisma.employee.findFirst({ where: { id: employeeId } });
      expect(employee?.leavePolicyId).toBe(org.leavePolicyId);

      // A real LeaveBalance row was created for EVERY leave type inside EVERY
      // selected policy bundle — this is the actual fix;
      // LeaveBalanceService.initializeForEmployee was previously never
      // invoked from any code path (see known-issues.md).
      const currentYear = new Date().getFullYear();
      const expectedTypes = await prisma.leavePolicyType.findMany({
        where: { leavePolicyId: { in: [org.leavePolicyId, org.secondLeavePolicyId] } },
      });
      const balances = await prisma.leaveBalance.findMany({
        where: { employeeId, year: currentYear },
        orderBy: { leavePolicyTypeId: 'asc' },
      });
      const balanceTypeIds = balances.map((b) => b.leavePolicyTypeId).sort();
      expect(balanceTypeIds).toEqual(expectedTypes.map((t) => t.id).sort());
      for (const balance of balances) {
        expect(balance.balanceDays).toBeGreaterThan(0);
        expect(balance.takenDays).toBe(0);
      }
    });

    it('rejects approving a link from another organization (org scoping, 404)', async () => {
      const orgA = await createOrgFixture('scope-a');
      const orgB = await createOrgFixture('scope-b');
      const created = await request(app.getHttpServer())
        .post('/api/v1/onboarding-links')
        .set(authed(orgA))
        .send(inviteBody())
        .expect(201);
      await forceUnderReview(created.body.data.id);

      await request(app.getHttpServer())
        .post(`/api/v1/onboarding-links/${created.body.data.id}/approve`)
        .set(authed(orgB))
        .send(approveBody(orgB))
        .expect(404);
    });
  });

  describe('#4 — backend validation surfaces the real message', () => {
    it('rejects an inactive leave policy with the real business message', async () => {
      const org = await createOrgFixture('inactive-leave');
      const created = await request(app.getHttpServer())
        .post('/api/v1/onboarding-links')
        .set(authed(org))
        .send(inviteBody())
        .expect(201);
      await forceUnderReview(created.body.data.id);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/onboarding-links/${created.body.data.id}/approve`)
        .set(authed(org))
        .send(approveBody(org, { leavePolicyIds: [org.inactiveLeavePolicyId] }))
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe(
        'One or more leave policies not found or inactive in this organization',
      );

      // Link must remain UNDER_REVIEW — a rejected activation must not have
      // side effects.
      const linkRes = await request(app.getHttpServer())
        .get(`/api/v1/onboarding-links/${created.body.data.id}`)
        .set(authed(org))
        .expect(200);
      expect(linkRes.body.data.status).toBe('UNDER_REVIEW');
      expect(linkRes.body.data.employeeId).toBeNull();
    });

    it('rejects a designation that does not belong to the given department with the real message', async () => {
      const org = await createOrgFixture('bad-designation');
      const created = await request(app.getHttpServer())
        .post('/api/v1/onboarding-links')
        .set(authed(org))
        .send(inviteBody())
        .expect(201);
      await forceUnderReview(created.body.data.id);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/onboarding-links/${created.body.data.id}/approve`)
        .set(authed(org))
        .send(approveBody(org, { designationId: org.otherDepartmentDesignationId }))
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Designation not found in the given department');
    });
  });
});
