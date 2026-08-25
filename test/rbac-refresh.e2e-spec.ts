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
 * Platform RBAC refresh endpoint coverage (`POST /platform/rbac/refresh`).
 *
 * Verifies:
 *  - 401 without a platform token (and 401 with a garbage/regular-org token,
 *    since `PlatformJwtStrategy` reads a separate `platform-authorization`
 *    header and rejects payloads whose `type !== 'platform'`).
 *  - 201 with a valid platform-admin token, returning the same
 *    `RbacRefreshSummary` shape the CLI (`npm run rbac:refresh`) produces.
 *  - The additive-merge contract: stripping a permission from a real
 *    seeded system role and re-running the endpoint restores it, and a
 *    second immediate call is a pure no-op (idempotent).
 *
 * Uses a synthetic platform admin (not the seeded `superadmin@platform.com`,
 * whose seeded password hash is of an empty string) so the test owns its own
 * known credentials end-to-end, and cleans it up in afterAll.
 */
describe('Platform RBAC refresh (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const PLATFORM_PASSWORD = 'PlatformTest@1234';
  let platformAdminId: string;
  let platformToken: string;

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

    const email = `rbac-e2e-admin-${uuid()}@platform.test`;
    const passwordHash = await bcrypt.hash(PLATFORM_PASSWORD, 10);
    const admin = await prisma.platformAdmin.create({
      data: {
        email,
        name: 'RBAC E2E Platform Admin',
        passwordHash,
        isActive: true,
      },
    });
    platformAdminId = admin.id;

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/platform/auth/login')
      .send({ email, password: PLATFORM_PASSWORD })
      .expect(201);

    platformToken = loginRes.body.data.token;
    expect(platformToken).toBeTruthy();
  });

  afterAll(async () => {
    await prisma.platformAdmin.delete({ where: { id: platformAdminId } }).catch(() => undefined);
    await app.close();
  });

  it('returns 401 with no platform auth header at all', async () => {
    await request(app.getHttpServer()).post('/api/v1/platform/rbac/refresh').expect(401);
  });

  it('returns 401 with a garbage/invalid platform token', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/platform/rbac/refresh')
      .set('platform-authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('returns 201 with a valid platform-admin token and the RbacRefreshSummary shape', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/platform/rbac/refresh')
      .set('platform-authorization', `Bearer ${platformToken}`)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        organizationsProcessed: expect.any(Number),
        rolesCreated: expect.any(Number),
        rolesUpdated: expect.any(Number),
        rolesUnchanged: expect.any(Number),
        permissionsAdded: expect.any(Number),
        details: expect.any(Array),
      }),
    );
  });

  it('additively restores a stripped permission and is idempotent on immediate re-run', async () => {
    const role = await prisma.role.findFirst({
      where: { name: 'hr_manager', isSystemRole: true },
    });
    expect(role).toBeTruthy();

    const originalPermissions = role!.permissions as string[];
    const removed = originalPermissions[0];
    await prisma.role.update({
      where: { id: role!.id },
      data: { permissions: originalPermissions.slice(1) },
    });

    const firstRun = await request(app.getHttpServer())
      .post('/api/v1/platform/rbac/refresh')
      .set('platform-authorization', `Bearer ${platformToken}`)
      .expect(201);

    expect(firstRun.body.data.rolesUpdated).toBeGreaterThanOrEqual(1);
    expect(firstRun.body.data.permissionsAdded).toBeGreaterThanOrEqual(1);

    const restored = await prisma.role.findUnique({ where: { id: role!.id } });
    expect((restored!.permissions as string[]).includes(removed)).toBe(true);
    expect((restored!.permissions as string[]).sort()).toEqual([...originalPermissions].sort());

    const secondRun = await request(app.getHttpServer())
      .post('/api/v1/platform/rbac/refresh')
      .set('platform-authorization', `Bearer ${platformToken}`)
      .expect(201);

    expect(secondRun.body.data.rolesCreated).toBe(0);
    expect(secondRun.body.data.rolesUpdated).toBe(0);
    expect(secondRun.body.data.permissionsAdded).toBe(0);
  });
});
