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
 * rbac-dashboard-taxrules-batch item 5 — Tax Rules CRUD, exercised at the
 * exact payload shape TaxRuleDialog.tsx builds for each calculationType
 * variant (PERCENTAGE/FIXED/SLAB_BASED), plus edit + soft-delete. Backend
 * was already built; this verifies the frontend's config-shape contract
 * actually round-trips through the real API.
 */
describe('Tax Rules — frontend payload-shape contract (e2e)', () => {
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
      await prisma.taxRule.deleteMany({ where: { organizationId } });
      await prisma.userRole.deleteMany({ where: { user: { organizationId } } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.employee.deleteMany({ where: { organizationId } });
      await prisma.designation.deleteMany({ where: { organizationId } });
      await prisma.department.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await app.close();
  });

  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const slug = `tax-rules-fe-contract-e2e-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: 'Tax Rules FE Contract E2E', slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const role = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: 'tax-rules-fe-e2e-finance',
        permissions: ['payroll:create', 'payroll:read'],
        isSystemRole: false,
      },
    });
    const department = await prisma.department.create({
      data: { organizationId: org.id, name: 'Finance' },
    });
    const designation = await prisma.designation.create({
      data: { organizationId: org.id, departmentId: department.id, name: 'Finance Manager' },
    });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const employee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        departmentId: department.id,
        designationId: designation.id,
        empCode: 'TR-FE-001',
        firstName: 'Finance',
        lastName: 'User',
        phone: '9876500001',
        status: 'ACTIVE',
      },
    });
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: employee.id,
        email: 'finance-e2e@tax-rules-fe.test',
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);
    token = login.body.data.accessToken;
    organizationId = org.id;
  });

  function authed() {
    return { Authorization: `Bearer ${token}`, 'X-Organization-ID': organizationId };
  }

  it('creates a PERCENTAGE tax rule with {rate, employeeSplit, employerSplit} config', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/tax-rules')
      .set(authed())
      .send({
        name: 'PF Rule',
        code: 'PF',
        type: 'PF',
        calculationType: 'PERCENTAGE',
        applicableOn: 'BASIC',
        isStatutory: true,
        config: { rate: 12, employeeSplit: 12, employerSplit: 13 },
        effectiveFrom: '2026-04-01',
      })
      .expect(201);
    expect(res.body.data.config).toEqual({ rate: 12, employeeSplit: 12, employerSplit: 13 });
    expect(res.body.data.calculationType).toBe('PERCENTAGE');
  });

  it('creates a FIXED tax rule with {amount} config', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/tax-rules')
      .set(authed())
      .send({
        name: 'Fixed Welfare Cess',
        type: 'WELFARE_CESS',
        calculationType: 'FIXED',
        applicableOn: 'GROSS',
        config: { amount: 500 },
        effectiveFrom: '2026-04-01',
      })
      .expect(201);
    expect(res.body.data.config).toEqual({ amount: 500 });
    expect(res.body.data.calculationType).toBe('FIXED');
  });

  it('creates + edits a SLAB_BASED tax rule, and slabs round-trip correctly', async () => {
    const slabs = [
      { fromAmount: 0, toAmount: 250000, rate: 0 },
      { fromAmount: 250000, toAmount: 500000, rate: 5 },
      { fromAmount: 500000, rate: 20 },
    ];

    const created = await request(app.getHttpServer())
      .post('/api/v1/tax-rules')
      .set(authed())
      .send({
        name: 'TDS Slabs FY26',
        type: 'TDS',
        calculationType: 'SLAB_BASED',
        applicableOn: 'GROSS',
        config: { slabs },
        effectiveFrom: '2026-04-01',
      })
      .expect(201);

    expect(created.body.data.config.slabs).toEqual(slabs);
    const id = created.body.data.id;

    // Edit: swap in a different slab set.
    const updatedSlabs = [
      { fromAmount: 0, toAmount: 300000, rate: 0 },
      { fromAmount: 300000, rate: 10, fixedAmount: 0 },
    ];
    const updated = await request(app.getHttpServer())
      .put(`/api/v1/tax-rules/${id}`)
      .set(authed())
      .send({ config: { slabs: updatedSlabs } })
      .expect(200);
    expect(updated.body.data.config.slabs).toEqual(updatedSlabs);

    // Round-trip via GET confirms persistence, not just the mutation response echo.
    const fetched = await request(app.getHttpServer())
      .get(`/api/v1/tax-rules/${id}`)
      .set(authed())
      .expect(200);
    expect(fetched.body.data.config.slabs).toEqual(updatedSlabs);

    // Soft-delete, then confirm it disappears from the active list and
    // appears in /tax-rules/trash.
    await request(app.getHttpServer()).delete(`/api/v1/tax-rules/${id}`).set(authed()).expect(200);

    const activeList = await request(app.getHttpServer())
      .get('/api/v1/tax-rules')
      .set(authed())
      .expect(200);
    const activeIds = (activeList.body.data.data as Array<{ id: string }>).map((r) => r.id);
    expect(activeIds).not.toContain(id);

    const trash = await request(app.getHttpServer())
      .get('/api/v1/tax-rules/trash')
      .set(authed())
      .expect(200);
    const trashIds = (trash.body.data.data as Array<{ id: string }>).map((r) => r.id);
    expect(trashIds).toContain(id);
  });
});
