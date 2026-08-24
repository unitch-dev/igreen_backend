import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * rbac-dashboard-taxrules-batch item 2 & 6 — verifies the seeded
 * manager/finance test logins (`prisma/seed-employees-payroll.ts
 * #seedManagerTestLogins`) actually carry the extra role's permissions
 * end-to-end through login -> JWT -> guarded endpoints, using the REAL
 * seeded iGreen Technologies org (not synthetic fixtures), matching the
 * pattern in permission-boundaries.e2e-spec.ts.
 *
 * ali1708@igreentec.in  -> base employee + finance_manager (payroll:create)
 * aru1675@igreentec.in  -> base employee + dept_manager (no payroll:create)
 * shi1878@igreentec.in  -> base employee only (no payroll:create)
 * Neither manager login holds role:assign (only org_admin/super_admin do).
 */
describe('Manager/finance seeded test logins — permission cross-check (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const SEED_PASSWORD = '123456';
  const TEMP_PASSWORD = 'TempTest@12345';
  const createdTaxRuleIds: string[] = [];
  const createdPayrollStructureIds: string[] = [];

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
    await prisma.taxRule.deleteMany({ where: { id: { in: createdTaxRuleIds } } });
    await prisma.payrollStructure.deleteMany({ where: { id: { in: createdPayrollStructureIds } } });
    await app.close();
  });

  function login(email: string, password: string) {
    return request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
  }

  async function loginAndClearMustChange(email: string) {
    const first = await login(email, SEED_PASSWORD).expect(200);
    if (!first.body.data.user.mustChangePassword) {
      return {
        token: first.body.data.accessToken as string,
        permissions: first.body.data.user.permissions as string[] | undefined,
        restore: async () => {},
      };
    }

    await request(app.getHttpServer())
      .put('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${first.body.data.accessToken}`)
      .send({ currentPassword: SEED_PASSWORD, newPassword: TEMP_PASSWORD })
      .expect(200);

    const second = await login(email, TEMP_PASSWORD).expect(200);
    expect(second.body.data.user.mustChangePassword).toBe(false);

    const restore = async () => {
      const user = await prisma.user.findFirst({ where: { email } });
      if (!user) return;
      const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: true },
      });
    };

    return {
      token: second.body.data.accessToken as string,
      permissions: second.body.data.user.permissions as string[] | undefined,
      restore,
    };
  }

  function authed(token: string, organizationId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Organization-ID': organizationId };
  }

  let orgId: string;
  let aliToken: string;
  let aliRestore: () => Promise<void>;
  let aruToken: string;
  let aruRestore: () => Promise<void>;
  let shiToken: string;
  let shiRestore: () => Promise<void>;

  beforeAll(async () => {
    const org = await prisma.organization.findFirst({ where: { name: { contains: 'iGreen' } } });
    if (!org) throw new Error('Seeded iGreen Technologies org not found — run the seeders first');
    orgId = org.id;

    const ali = await loginAndClearMustChange('ali1708@igreentec.in');
    aliToken = ali.token;
    aliRestore = ali.restore;

    const aru = await loginAndClearMustChange('aru1675@igreentec.in');
    aruToken = aru.token;
    aruRestore = aru.restore;

    const shi = await loginAndClearMustChange('shi1878@igreentec.in');
    shiToken = shi.token;
    shiRestore = shi.restore;
  });

  afterAll(async () => {
    await aliRestore();
    await aruRestore();
    await shiRestore();
  });

  it('UserRole rows: ali1708 holds employee+finance_manager, aru1675 holds employee+dept_manager', async () => {
    const ali = await prisma.user.findFirst({
      where: { email: 'ali1708@igreentec.in' },
      include: { userRoles: { include: { role: true } } },
    });
    const aru = await prisma.user.findFirst({
      where: { email: 'aru1675@igreentec.in' },
      include: { userRoles: { include: { role: true } } },
    });
    expect(ali?.userRoles.map((r) => r.role.name).sort()).toEqual(
      ['employee', 'finance_manager'].sort(),
    );
    expect(aru?.userRoles.map((r) => r.role.name).sort()).toEqual(
      ['dept_manager', 'employee'].sort(),
    );
  });

  it('ali1708 (finance_manager) can reach POST /payroll-structures (item 6)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/payroll-structures')
      .set(authed(aliToken, orgId))
      .send({
        name: `E2E Finance Test Structure ${Date.now()}`,
        components: [
          { name: 'Basic', type: 'PERCENTAGE', value: 40, baseOn: 'CTC', isDeductible: false },
        ],
        isActive: true,
      })
      .expect(201);
    createdPayrollStructureIds.push(res.body.data.id);
    expect(res.body.success).toBe(true);
  });

  it('ali1708 (finance_manager) can reach POST /tax-rules', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/tax-rules')
      .set(authed(aliToken, orgId))
      .send({
        name: `E2E Finance Test Tax Rule ${Date.now()}`,
        type: 'PF',
        calculationType: 'PERCENTAGE',
        applicableOn: 'BASIC',
        config: { rate: 12 },
        effectiveFrom: '2026-04-01',
      })
      .expect(201);
    createdTaxRuleIds.push(res.body.data.id);
    expect(res.body.success).toBe(true);
  });

  it('a plain employee login (shi1878) is DENIED payroll:create on both endpoints', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payroll-structures')
      .set(authed(shiToken, orgId))
      .send({
        name: `Should Be Denied ${Date.now()}`,
        components: [
          { name: 'Basic', type: 'PERCENTAGE', value: 40, baseOn: 'CTC', isDeductible: false },
        ],
      })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/tax-rules')
      .set(authed(shiToken, orgId))
      .send({
        name: `Should Be Denied ${Date.now()}`,
        type: 'PF',
        calculationType: 'PERCENTAGE',
        applicableOn: 'BASIC',
        config: { rate: 12 },
        effectiveFrom: '2026-04-01',
      })
      .expect(403);
  });

  it('dept_manager (aru1675) is DENIED payroll:create — role scoping is correct, not "any manager"', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payroll-structures')
      .set(authed(aruToken, orgId))
      .send({
        name: `Should Be Denied ${Date.now()}`,
        components: [
          { name: 'Basic', type: 'PERCENTAGE', value: 40, baseOn: 'CTC', isDeductible: false },
        ],
      })
      .expect(403);
  });

  it('neither ali1708 (finance_manager) nor aru1675 (dept_manager) holds role:assign', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/roles/assign')
      .set(authed(aliToken, orgId))
      .send({
        userId: 'irrelevant-uuid-value-000000000000',
        roleId: 'irrelevant-uuid-value-000001',
      })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/roles/assign')
      .set(authed(aruToken, orgId))
      .send({
        userId: 'irrelevant-uuid-value-000000000000',
        roleId: 'irrelevant-uuid-value-000001',
      })
      .expect(403);
  });
});
