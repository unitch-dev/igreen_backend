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
 * GET /dashboards — role-aware dashboard resolution (rbac-dashboard-taxrules
 * batch, item 4). Covers the fix to DashboardController.findForUser's
 * roleName resolution, which previously collapsed every non-super_admin
 * user to the same 'employee' dashboard regardless of their actual roles.
 */
describe('Dashboards — GET /dashboards role-aware resolution (e2e)', () => {
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
      // DashboardWidget cascades on DashboardConfig delete — no separate cleanup needed.
      await prisma.dashboardConfig.deleteMany({ where: { organizationId } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.employee.deleteMany({ where: { organizationId } });
      await prisma.designation.deleteMany({ where: { organizationId } });
      await prisma.department.deleteMany({ where: { organizationId } });
      await prisma.role.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await app.close();
  });

  interface UserFixture {
    token: string;
  }

  async function createOrgWithUsers(label: string): Promise<{
    organizationId: string;
    admin: UserFixture;
    employee: UserFixture;
  }> {
    const slug = `dashboard-rbac-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Dashboard RBAC E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const orgAdminRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: 'org_admin',
        permissions: ['*'],
        isSystemRole: false,
      },
    });
    const employeeRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: 'employee',
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

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    async function makeUser(roleId: string, tag: string): Promise<UserFixture> {
      const emp = await prisma.employee.create({
        data: {
          organizationId: org.id,
          departmentId: department.id,
          designationId: designation.id,
          empCode: `${tag}-${label}`,
          firstName: tag,
          lastName: label,
          phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
          status: 'ACTIVE',
        },
      });
      const user = await prisma.user.create({
        data: {
          organizationId: org.id,
          employeeId: emp.id,
          email: `${tag}-${label}@dashboard-rbac-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId } });

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);

      return { token: login.body.data.accessToken };
    }

    const admin = await makeUser(orgAdminRole.id, 'admin');
    const employee = await makeUser(employeeRole.id, 'employee');

    return { organizationId: org.id, admin, employee };
  }

  function authed(organizationId: string, token: string) {
    return { Authorization: `Bearer ${token}`, 'X-Organization-ID': organizationId };
  }

  it('seed-defaults creates role-default dashboards, and org_admin vs employee get genuinely different widget sets', async () => {
    const { organizationId, admin, employee } = await createOrgWithUsers('happy');

    // Seed default dashboards for this org (mirrors prisma/seed.ts wiring).
    await request(app.getHttpServer())
      .post('/api/v1/dashboards/seed-defaults')
      .set(authed(organizationId, admin.token))
      .expect(201);

    const adminRes = await request(app.getHttpServer())
      .get('/api/v1/dashboards')
      .set(authed(organizationId, admin.token))
      .expect(200);
    const employeeRes = await request(app.getHttpServer())
      .get('/api/v1/dashboards')
      .set(authed(organizationId, employee.token))
      .expect(200);

    interface WidgetLike {
      widgetType: string;
    }
    interface ConfigLike {
      roleName: string;
      widgets: WidgetLike[];
    }

    const adminConfigs: ConfigLike[] = adminRes.body.data;
    const employeeConfigs: ConfigLike[] = employeeRes.body.data;

    const adminDefault = adminConfigs.find((c) => c.roleName === 'org_admin');
    const employeeDefault = employeeConfigs.find((c) => c.roleName === 'employee');
    expect(adminDefault).toBeTruthy();
    expect(employeeDefault).toBeTruthy();

    // The employee response must NOT collapse to the org_admin config (the
    // exact bug this fix addresses) — no org_admin-only widget types like
    // map_live_tracking / table_loan_leave_summary should appear.
    // NOTE: these widget type strings must stay in sync with DEFAULT_DASHBOARDS
    // in dashboard.service.ts (see dashboard-widget-refresh.md) — if that
    // definition changes, update these assertions in the same change.
    const employeeWidgetTypes = new Set(
      employeeConfigs.flatMap((c) => c.widgets.map((w) => w.widgetType)),
    );
    expect(employeeWidgetTypes.has('map_live_tracking')).toBe(false);
    expect(employeeWidgetTypes.has('table_loan_leave_summary')).toBe(false);
    expect(employeeWidgetTypes.has('clock_checkin')).toBe(true);
    expect(employeeWidgetTypes.has('kpi_my_leave_balance')).toBe(true);
    expect(employeeWidgetTypes.has('list_my_todos')).toBe(true);
    expect(employeeWidgetTypes.has('widget_green_thanks')).toBe(true);
    expect(employeeWidgetTypes.has('list_notices')).toBe(true);

    const adminWidgetTypes = new Set(
      adminConfigs.flatMap((c) => c.widgets.map((w) => w.widgetType)),
    );
    expect(adminWidgetTypes.has('map_live_tracking')).toBe(true);
    expect(adminWidgetTypes.has('table_loan_leave_summary')).toBe(true);
    expect(adminWidgetTypes.has('list_notifications')).toBe(true);

    // Genuinely different sets, not the same list reused.
    expect(employeeWidgetTypes).not.toEqual(adminWidgetTypes);
  });

  it('seed-defaults is idempotent (safe to re-run without duplicating configs)', async () => {
    const { organizationId, admin } = await createOrgWithUsers('idempotent');

    await request(app.getHttpServer())
      .post('/api/v1/dashboards/seed-defaults')
      .set(authed(organizationId, admin.token))
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/dashboards/seed-defaults')
      .set(authed(organizationId, admin.token))
      .expect(201);

    const configs = await prisma.dashboardConfig.findMany({
      where: { organizationId, roleName: 'org_admin', isDefault: true },
    });
    expect(configs.length).toBe(1);
  });
});
