import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';

/**
 * Per-tenant logo branding (see docs/modules/tenant-logo-branding.md):
 *  - POST /organization/logo (org:update only) uploads + replaces the org
 *    logo, rejects non-images and oversized files.
 *  - POST /auth/login + GET /auth/me both enrich `user` with
 *    organizationName/organizationLogoUrl for EVERY authenticated user,
 *    including an employee-role user with NO org:read.
 *  - Cross-user propagation: a different user in the same org sees the new
 *    logo on their next login/me call.
 *  - null logoUrl -> organizationLogoUrl: null (generic Sidebar fallback).
 */
describe('Per-tenant logo branding (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const PASSWORD = 'Test@1234';
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
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

    // Mirror main.ts's static /uploads mount so the dogfooding test can
    // assert the seeded logo URL is actually reachable, not just present.
    const configService = app.get(ConfigService);
    app.useStaticAssets(path.join(process.cwd(), configService.get<string>('storage.localDir')), {
      prefix: '/uploads',
    });

    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    for (const organizationId of createdOrgIds) {
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
    adminToken: string; // org:update, no org:read (deliberately, to prove org:update alone can upload)
    employeeToken: string; // no org:read, no org:update
    employeeEmail: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `logo-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `Logo E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const adminRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `logo-e2e-admin-${label}`,
        description: 'org:update only',
        permissions: ['org:update'],
        isSystemRole: false,
      },
    });

    const employeeRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `logo-e2e-employee-${label}`,
        description: 'No org permissions at all',
        permissions: ['leave:apply'],
        isSystemRole: false,
      },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const adminUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `admin-${label}@logo-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: adminUser.id, roleId: adminRole.id } });

    const employeeUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `employee-${label}@logo-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: employeeUser.id, roleId: employeeRole.id } });

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: PASSWORD })
      .expect(200);

    const employeeLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: employeeUser.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      adminToken: adminLogin.body.data.accessToken,
      employeeToken: employeeLogin.body.data.accessToken,
      employeeEmail: employeeUser.email,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  // Minimal valid 1x1 PNG.
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  describe('POST /organization/logo', () => {
    it('200s + updates logoUrl for a user with org:update', async () => {
      const org = await createOrgFixture('upload-ok');

      const res = await request(app.getHttpServer())
        .post('/api/v1/organization/logo')
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', PNG_1PX, 'logo.png')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.logoUrl).toBe('string');
      // Folder convention (see FilesService.upload / docs/modules/file-asset-storage-refactor.md):
      // uploads/{entityType}/{organizationId}/{entityId ?? 'unassigned'}/{uuid}-{fileName}
      expect(res.body.data.logoUrl).toContain(
        `ORGANIZATION_LOGO/${org.organizationId}/${org.organizationId}/`,
      );

      const dbOrg = await prisma.organization.findUnique({ where: { id: org.organizationId } });
      expect(dbOrg?.logoUrl).toBe(res.body.data.logoUrl);
    });

    it('403s for a user lacking org:update', async () => {
      const org = await createOrgFixture('upload-403');

      await request(app.getHttpServer())
        .post('/api/v1/organization/logo')
        .set(authed(org.employeeToken, org.organizationId))
        .attach('file', PNG_1PX, 'logo.png')
        .expect(403);
    });

    it('rejects a non-image file with 400', async () => {
      const org = await createOrgFixture('upload-badtype');

      await request(app.getHttpServer())
        .post('/api/v1/organization/logo')
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', Buffer.from('not an image'), {
          filename: 'evil.exe',
          contentType: 'application/x-msdownload',
        })
        .expect(400);
    });

    it('rejects an oversized file (> 5MB)', async () => {
      const org = await createOrgFixture('upload-toobig');
      const oversized = Buffer.alloc(6 * 1024 * 1024, 1);

      await request(app.getHttpServer())
        .post('/api/v1/organization/logo')
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', oversized, { filename: 'huge.png', contentType: 'image/png' })
        .expect((res) => {
          expect([400, 413]).toContain(res.status);
        });
    });
  });

  describe('Auth response enrichment (login + me)', () => {
    it('login returns organizationName/organizationLogoUrl for an employee-role user with NO org:read', async () => {
      const org = await createOrgFixture('login-enrich');

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: org.employeeEmail, password: PASSWORD })
        .expect(200);

      expect(login.body.data.user.organizationName).toBe(`Logo E2E login-enrich`);
      expect(login.body.data.user.organizationLogoUrl).toBeNull();
    });

    it('GET /auth/me returns organizationName/organizationLogoUrl for the same employee-role user', async () => {
      const org = await createOrgFixture('me-enrich');

      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(authed(org.employeeToken, org.organizationId))
        .expect(200);

      expect(me.body.data.organizationName).toBe(`Logo E2E me-enrich`);
      expect(me.body.data.organizationLogoUrl).toBeNull();
    });

    it('null logoUrl org yields organizationLogoUrl: null (generic fallback)', async () => {
      const org = await createOrgFixture('null-logo');
      const dbOrg = await prisma.organization.findUnique({ where: { id: org.organizationId } });
      expect(dbOrg?.logoUrl).toBeNull();

      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(authed(org.employeeToken, org.organizationId))
        .expect(200);

      expect(me.body.data.organizationLogoUrl).toBeNull();
    });
  });

  describe('Cross-user propagation', () => {
    it('a different user in the same org sees the NEW logo on their next login', async () => {
      const org = await createOrgFixture('propagation');

      // Sanity: employee sees null before upload.
      const before = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: org.employeeEmail, password: PASSWORD })
        .expect(200);
      expect(before.body.data.user.organizationLogoUrl).toBeNull();

      const upload = await request(app.getHttpServer())
        .post('/api/v1/organization/logo')
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', PNG_1PX, 'logo.png')
        .expect(200);
      const newLogoUrl = upload.body.data.logoUrl;

      const after = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: org.employeeEmail, password: PASSWORD })
        .expect(200);
      expect(after.body.data.user.organizationLogoUrl).toBe(newLogoUrl);

      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set(authed(org.employeeToken, org.organizationId))
        .expect(200);
      expect(me.body.data.organizationLogoUrl).toBe(newLogoUrl);
    });
  });

  describe('Dogfooding: seeded iGreen org', () => {
    it('has a non-null organizationLogoUrl pointing at a reachable /uploads URL', async () => {
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'admin@igreentec.in', password: 'Admin@1234' })
        .expect(200);

      const logoUrl = login.body.data.user.organizationLogoUrl as string;
      expect(logoUrl).toBeTruthy();
      expect(logoUrl).toContain('/uploads/organizations/');

      // Actually reachable via the app's static /uploads route (200), not
      // just present on disk.
      const relativePath = logoUrl.substring(logoUrl.indexOf('/uploads/'));
      await request(app.getHttpServer()).get(relativePath).expect(200);
    });
  });
});
