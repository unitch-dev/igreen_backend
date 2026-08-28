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
 * Leave module maker-checker regression (hrms-backend.md §26):
 *  - A leave applicant who ALSO holds `leave:approve` must still be blocked
 *    (403) from approving/rejecting their OWN leave application.
 *  - A DIFFERENT user holding `leave:approve` must still be able to
 *    approve/reject normally — the guard blocks only self-approval.
 *
 * Runs against the real dev MySQL/Redis instance (same as `npm run start:dev`).
 */
describe('Leave module — maker-checker self-approval guard (e2e)', () => {
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

      await prisma.leaveApplication.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leavePolicy.deleteMany({ where: { organizationId } });
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
    leavePolicyTypeId: string;
    approverToken: string;
    applicantUserId: string;
    applicantEmail: string;
    applicantId: string;
    applicantToken: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `leave-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Leave E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const approverRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `leave-e2e-approver-${label}`,
        description: 'Test approver role',
        permissions: ['leave:read', 'leave:apply', 'leave:approve'],
        isSystemRole: false,
      },
    });

    const applicantRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `leave-e2e-applicant-${label}`,
        description: 'Test applicant role',
        permissions: ['leave:read', 'leave:apply'],
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
      data: {
        organizationId: org.id,
        name: `Casual Leave ${label}`,
        types: {
          create: { leaveType: 'CASUAL', daysPerYear: 12 },
        },
      },
      include: { types: true },
    });
    const leavePolicyType = leavePolicy.types[0];

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const approverEmployee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `APR-${label}`,
        firstName: 'Approver',
        lastName: label,
        phone: '9200000001',
        departmentId: department.id,
        designationId: designation.id,
        status: 'ACTIVE',
      },
    });
    const approverUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: approverEmployee.id,
        email: `approver-${label}@leave-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: approverUser.id, roleId: approverRole.id } });

    const applicant = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `APL-${label}`,
        firstName: 'Applicant',
        lastName: label,
        phone: '9200000002',
        departmentId: department.id,
        designationId: designation.id,
        status: 'ACTIVE',
      },
    });
    const applicantEmail = `applicant-${label}@leave-e2e.test`;
    const applicantUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: applicant.id,
        email: applicantEmail,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: applicantUser.id, roleId: applicantRole.id } });

    const currentYear = new Date().getFullYear();
    await prisma.leaveBalance.create({
      data: {
        employeeId: applicant.id,
        leavePolicyTypeId: leavePolicyType.id,
        year: currentYear,
        entitledDays: 12,
        balanceDays: 12,
      },
    });
    await prisma.leaveBalance.create({
      data: {
        employeeId: approverEmployee.id,
        leavePolicyTypeId: leavePolicyType.id,
        year: currentYear,
        entitledDays: 12,
        balanceDays: 12,
      },
    });

    const approverLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: approverUser.email, password: PASSWORD })
      .expect(200);
    const applicantLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: applicantEmail, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      leavePolicyTypeId: leavePolicyType.id,
      approverToken: approverLogin.body.data.accessToken,
      applicantUserId: applicantUser.id,
      applicantEmail,
      applicantId: applicant.id,
      applicantToken: applicantLogin.body.data.accessToken,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  async function applyLeave(org: OrgFixture, days: number, date: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/leave/apply')
      .set(authed(org.applicantToken, org.organizationId))
      .send({
        leavePolicyTypeId: org.leavePolicyTypeId,
        fromDate: date,
        toDate: date,
        days,
        reason: 'Personal',
      })
      .expect(201);
    return res.body.data.id as string;
  }

  describe('Maker-checker: self-approval guard', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('self-approval');

      // Grant the applicant's own user leave:approve too, then re-login to
      // pick up the newly-flattened permission in the JWT.
      const approverRole = await prisma.role.findFirstOrThrow({
        where: { organizationId: org.organizationId, name: 'leave-e2e-approver-self-approval' },
      });
      await prisma.userRole.create({
        data: { userId: org.applicantUserId, roleId: approverRole.id },
      });
      const relogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: org.applicantEmail, password: PASSWORD })
        .expect(200);
      org = { ...org, applicantToken: relogin.body.data.accessToken };
    });

    it('the applicant, even holding leave:approve, gets 403 approving their own leave application', async () => {
      const id = await applyLeave(org, 1, '2026-09-01');

      const res = await request(app.getHttpServer())
        .put(`/api/v1/leave/${id}/approve`)
        .set(authed(org.applicantToken, org.organizationId))
        .send({ notes: 'Self approve attempt' })
        .expect(403);
      expect(res.body.message).toMatch(/own/i);
    });

    it('the applicant, even holding leave:approve, gets 403 rejecting their own leave application', async () => {
      const id = await applyLeave(org, 1, '2026-09-03');

      const res = await request(app.getHttpServer())
        .put(`/api/v1/leave/${id}/reject`)
        .set(authed(org.applicantToken, org.organizationId))
        .send({ rejectionNote: 'Self reject attempt' })
        .expect(403);
      expect(res.body.message).toMatch(/own/i);
    });

    it('a DIFFERENT user holding leave:approve can approve the same applicant leave normally', async () => {
      const id = await applyLeave(org, 1, '2026-09-05');

      const res = await request(app.getHttpServer())
        .put(`/api/v1/leave/${id}/approve`)
        .set(authed(org.approverToken, org.organizationId))
        .send({ notes: 'Approved by a different user' })
        .expect(200);
      expect(res.body.data.status).toBe('APPROVED');
    });
  });

  // ─── GET /leave/global-leaves/my — employee-less admin account guard ──────
  // (docs/known-issues.md 2026-08-28 [leave/global-leave-my-crash])
  //
  // Previously 500'd for org_admin/super_admin accounts (employeeId: null,
  // e.g. seeded admin@igreentec.in) because GlobalLeaveService.getForEmployee
  // passed a null employeeId into prisma.employee.findFirst. Fixed to skip
  // the employee/zone lookup entirely when employeeId is null and return
  // only appliesToAll:true entries. This block also regression-covers the
  // two pre-existing employee paths (with/without a zoneId) to confirm the
  // fix didn't change their behavior.
  describe('GET /leave/global-leaves/my — employee-less admin account guard', () => {
    const YEAR = 2027;
    let org: OrgFixture;
    let zoneId: string;
    let globalLeaveAllId: string;
    let zoneOnlyLeaveId: string;

    beforeAll(async () => {
      org = await createOrgFixture('global-leaves-my');

      const zone = await prisma.zone.create({
        data: { organizationId: org.organizationId, name: 'Zone A', isActive: true },
      });
      zoneId = zone.id;

      // Assign the approver employee to the zone; leave the applicant with
      // no zoneId to exercise the "no zone" regression path.
      await prisma.employee.update({
        where: { id: org.applicantId },
        data: { zoneId: null },
      });

      const approverEmployee = await prisma.employee.findFirstOrThrow({
        where: { organizationId: org.organizationId, empCode: { startsWith: 'APR-' } },
      });
      await prisma.employee.update({
        where: { id: approverEmployee.id },
        data: { zoneId },
      });

      const appliesToAll = await prisma.globalLeave.create({
        data: {
          organizationId: org.organizationId,
          name: `Org-wide Holiday ${YEAR}`,
          date: new Date(Date.UTC(YEAR, 5, 15)),
          appliesToAll: true,
        },
      });
      globalLeaveAllId = appliesToAll.id;

      const zoneOnly = await prisma.globalLeave.create({
        data: {
          organizationId: org.organizationId,
          name: `Zone A Festival ${YEAR}`,
          date: new Date(Date.UTC(YEAR, 7, 20)),
          appliesToAll: false,
          zones: { connect: { id: zoneId } },
        },
      });
      zoneOnlyLeaveId = zoneOnly.id;
    });

    afterAll(async () => {
      await prisma.globalLeave.deleteMany({
        where: { id: { in: [globalLeaveAllId, zoneOnlyLeaveId] } },
      });
      await prisma.zone.delete({ where: { id: zoneId } });
    });

    it('org_admin account (employeeId: null) gets 200 with only appliesToAll entries, not the 500 from the bug', async () => {
      const adminUser = await prisma.user.findFirst({ where: { email: 'admin@igreentec.in' } });
      if (!adminUser) throw new Error('Seeded admin@igreentec.in not found — run the seeders first');
      if (adminUser.employeeId !== null) {
        throw new Error(
          'Seeded admin@igreentec.in unexpectedly has an employeeId — DB drift from the ' +
            'documented seed state; this guard cannot be exercised until reseeded.',
        );
      }

      const adminLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'admin@igreentec.in', password: 'Admin@1234' })
        .expect(200);
      const adminToken = adminLogin.body.data.accessToken as string;

      // Admin's real org is used (its employee-less user has no membership
      // in the synthetic `org` fixture above), so create the same
      // appliesToAll/zone-tagged pair scoped to the admin's actual org for
      // this one assertion, and clean them up locally.
      const adminOrgId = adminUser.organizationId;
      const adminZone = await prisma.zone.create({
        data: { organizationId: adminOrgId, name: `Admin Guard Zone ${uuid()}`, isActive: true },
      });
      const adminAppliesToAll = await prisma.globalLeave.create({
        data: {
          organizationId: adminOrgId,
          name: `Admin Guard Org-wide ${YEAR}`,
          date: new Date(Date.UTC(YEAR, 2, 10)),
          appliesToAll: true,
        },
      });
      const adminZoneOnly = await prisma.globalLeave.create({
        data: {
          organizationId: adminOrgId,
          name: `Admin Guard Zone-only ${YEAR}`,
          date: new Date(Date.UTC(YEAR, 3, 10)),
          appliesToAll: false,
          zones: { connect: { id: adminZone.id } },
        },
      });

      try {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/leave/global-leaves/my?year=${YEAR}`)
          .set(authed(adminToken, adminOrgId))
          .expect(200);

        const names = (res.body.data as Array<{ name: string; appliesToAll: boolean }>).map(
          (item) => item.name,
        );
        expect(names).toContain(adminAppliesToAll.name);
        expect(names).not.toContain(adminZoneOnly.name);
        expect(
          (res.body.data as Array<{ appliesToAll: boolean }>).every((item) => item.appliesToAll),
        ).toBe(true);
      } finally {
        await prisma.globalLeave.deleteMany({
          where: { id: { in: [adminAppliesToAll.id, adminZoneOnly.id] } },
        });
        await prisma.zone.delete({ where: { id: adminZone.id } });
      }
    });

    it('regular employee WITH a zoneId gets appliesToAll + their zone-tagged entries (no regression)', async () => {
      const approverEmployee = await prisma.employee.findFirstOrThrow({
        where: { organizationId: org.organizationId, empCode: { startsWith: 'APR-' } },
      });
      expect(approverEmployee.zoneId).toBe(zoneId);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/leave/global-leaves/my?year=${YEAR}`)
        .set(authed(org.approverToken, org.organizationId))
        .expect(200);

      const names = (res.body.data as Array<{ name: string }>).map((item) => item.name);
      expect(names).toEqual(
        expect.arrayContaining([`Org-wide Holiday ${YEAR}`, `Zone A Festival ${YEAR}`]),
      );
      expect(res.body.data).toHaveLength(2);
    });

    it('regular employee with NO zoneId gets appliesToAll only (no regression)', async () => {
      const applicantEmployee = await prisma.employee.findFirstOrThrow({
        where: { id: org.applicantId },
      });
      expect(applicantEmployee.zoneId).toBeNull();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/leave/global-leaves/my?year=${YEAR}`)
        .set(authed(org.applicantToken, org.organizationId))
        .expect(200);

      const names = (res.body.data as Array<{ name: string }>).map((item) => item.name);
      expect(names).toContain(`Org-wide Holiday ${YEAR}`);
      expect(names).not.toContain(`Zone A Festival ${YEAR}`);
    });
  });
});
