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
 * Payroll Structures CRUD (frontend integration round) + employee
 * payroll-structure reassignment:
 *  - POST/GET/PUT/DELETE /payroll-structures — response envelope, service-level
 *    validation messages (unique names, at least one earning, PERCENTAGE/FIXED
 *    bounds), soft-delete blocked when employees are assigned.
 *  - Multi-tenancy: org B never sees org A's structures.
 *  - PUT /employees/:id — payrollStructureId reassignment, and that a
 *    cross-org payrollStructureId is rejected (regression test for the
 *    missing-validation bug found & fixed during this testing round).
 */
describe('Payroll Structures + employee reassignment (e2e)', () => {
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

      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.loginHistory.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
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
    adminToken: string;
    employeeId: string;
  }

  const VALID_COMPONENTS = [
    { name: 'Basic', type: 'FIXED', value: 30000, isDeductible: false },
    { name: 'PF', type: 'PERCENTAGE', value: 12, baseOn: 'BASIC', isDeductible: true },
  ];

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `payroll-structures-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Payroll Structures E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const adminRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `payroll-structures-e2e-admin-${label}`,
        description: 'Test admin role',
        permissions: [
          'payroll:read',
          'payroll:create',
          'payroll:update',
          'payroll:delete',
          'employee:read',
          'employee:update',
        ],
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
        name: `Seed Structure ${label}`,
        components: VALID_COMPONENTS,
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const adminEmployee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `ADM-${label}`,
        firstName: 'Admin',
        lastName: label,
        phone: '9000000001',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });
    const adminUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: adminEmployee.id,
        email: `admin-${label}@payroll-structures-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: adminUser.id, roleId: adminRole.id } });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      departmentId: department.id,
      designationId: designation.id,
      payrollStructureId: payrollStructure.id,
      adminToken: login.body.data.accessToken,
      employeeId: adminEmployee.id,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  // ─── POST /payroll-structures ────────────────────────────────────────────

  describe('POST /payroll-structures', () => {
    it('creates a structure with 2+ components incl. one non-deductible earning', async () => {
      const org = await createOrgFixture('create-ok');
      const res = await request(app.getHttpServer())
        .post('/api/v1/payroll-structures')
        .set(authed(org.adminToken, org.organizationId))
        .send({ name: 'Standard CTC Structure', components: VALID_COMPONENTS, isActive: true })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Standard CTC Structure');
      expect(res.body.data.components).toHaveLength(2);

      const list = await request(app.getHttpServer())
        .get('/api/v1/payroll-structures')
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(list.body.data.data.some((s: any) => s.name === 'Standard CTC Structure')).toBe(true);
    });

    it('rejects a structure with NO non-deductible earning component with the real backend message', async () => {
      const org = await createOrgFixture('create-no-earning');
      const res = await request(app.getHttpServer())
        .post('/api/v1/payroll-structures')
        .set(authed(org.adminToken, org.organizationId))
        .send({
          name: 'All Deductions',
          components: [{ name: 'PF', type: 'PERCENTAGE', value: 12, isDeductible: true }],
        })
        .expect(400);

      expect(res.body.message).toMatch(/at least one earning component/i);
    });

    it('rejects a PERCENTAGE component value of 150 with the real backend message', async () => {
      const org = await createOrgFixture('create-bad-percentage');
      const res = await request(app.getHttpServer())
        .post('/api/v1/payroll-structures')
        .set(authed(org.adminToken, org.organizationId))
        .send({
          name: 'Bad Percentage',
          components: [
            { name: 'Basic', type: 'FIXED', value: 30000, isDeductible: false },
            { name: 'Bonus', type: 'PERCENTAGE', value: 150, isDeductible: false },
          ],
        })
        .expect(400);

      expect(res.body.message).toMatch(/PERCENTAGE.*between 0 and 100/i);
    });
  });

  // ─── PUT /payroll-structures/:id ─────────────────────────────────────────

  describe('PUT /payroll-structures/:id', () => {
    it('persists a components edit — GET reflects the change', async () => {
      const org = await createOrgFixture('edit');
      const created = await request(app.getHttpServer())
        .post('/api/v1/payroll-structures')
        .set(authed(org.adminToken, org.organizationId))
        .send({ name: 'Editable Structure', components: VALID_COMPONENTS })
        .expect(201);
      const id = created.body.data.id;

      const newComponents = [
        { name: 'Basic', type: 'FIXED', value: 35000, isDeductible: false },
        { name: 'HRA', type: 'FIXED', value: 10000, isDeductible: false },
        { name: 'PF', type: 'PERCENTAGE', value: 12, baseOn: 'BASIC', isDeductible: true },
      ];
      await request(app.getHttpServer())
        .put(`/api/v1/payroll-structures/${id}`)
        .set(authed(org.adminToken, org.organizationId))
        .send({ components: newComponents })
        .expect(200);

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/payroll-structures/${id}`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(fetched.body.data.components).toHaveLength(3);
      expect(fetched.body.data.components.find((c: any) => c.name === 'HRA').value).toBe(10000);
    });
  });

  // ─── DELETE /payroll-structures/:id ──────────────────────────────────────

  describe('DELETE /payroll-structures/:id', () => {
    it('blocks deletion with the real "employees assigned" message when employees are assigned', async () => {
      const org = await createOrgFixture('delete-blocked');
      // org.payrollStructureId already has org.employeeId assigned to it (fixture setup)
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/payroll-structures/${org.payrollStructureId}`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(400);

      expect(res.body.message).toMatch(/employee\(s\) are assigned/i);
    });

    it('deletes an unassigned structure successfully', async () => {
      const org = await createOrgFixture('delete-ok');
      const created = await request(app.getHttpServer())
        .post('/api/v1/payroll-structures')
        .set(authed(org.adminToken, org.organizationId))
        .send({ name: 'Unassigned Structure', components: VALID_COMPONENTS })
        .expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .delete(`/api/v1/payroll-structures/${id}`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);

      const list = await request(app.getHttpServer())
        .get('/api/v1/payroll-structures')
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(list.body.data.data.some((s: any) => s.id === id)).toBe(false);
    });
  });

  // ─── Multi-tenancy ────────────────────────────────────────────────────────

  describe('Multi-tenancy scoping', () => {
    it("org B's payroll structure list never includes org A's structures", async () => {
      const orgA = await createOrgFixture('tenant-a');
      const orgB = await createOrgFixture('tenant-b');

      const list = await request(app.getHttpServer())
        .get('/api/v1/payroll-structures')
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(200);

      expect(list.body.data.data.some((s: any) => s.id === orgA.payrollStructureId)).toBe(false);
    });
  });

  // ─── PUT /employees/:id — payroll structure reassignment ────────────────

  describe('PUT /employees/:id — payroll structure reassignment', () => {
    it('reassigns an employee to a new structure; GET /employees/:id reflects it', async () => {
      const org = await createOrgFixture('reassign');
      const newStructure = await request(app.getHttpServer())
        .post('/api/v1/payroll-structures')
        .set(authed(org.adminToken, org.organizationId))
        .send({ name: 'New Structure For Reassignment', components: VALID_COMPONENTS })
        .expect(201);

      await request(app.getHttpServer())
        .put(`/api/v1/employees/${org.employeeId}`)
        .set(authed(org.adminToken, org.organizationId))
        .send({ payrollStructureId: newStructure.body.data.id })
        .expect(200);

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/employees/${org.employeeId}`)
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(fetched.body.data.payrollStructureId).toBe(newStructure.body.data.id);
      expect(fetched.body.data.payrollStructure.name).toBe('New Structure For Reassignment');
    });

    it('rejects a payrollStructureId belonging to a different org (regression: cross-org FK was unvalidated)', async () => {
      const orgA = await createOrgFixture('reassign-cross-org-a');
      const orgB = await createOrgFixture('reassign-cross-org-b');

      const res = await request(app.getHttpServer())
        .put(`/api/v1/employees/${orgA.employeeId}`)
        .set(authed(orgA.adminToken, orgA.organizationId))
        .send({ payrollStructureId: orgB.payrollStructureId })
        .expect(400);

      expect(res.body.message).toMatch(/payroll structure.*not found in this organization/i);

      // Confirm the FK was NOT written despite the attempt
      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/employees/${orgA.employeeId}`)
        .set(authed(orgA.adminToken, orgA.organizationId))
        .expect(200);
      expect(fetched.body.data.payrollStructureId).toBe(orgA.payrollStructureId);
    });
  });
});
