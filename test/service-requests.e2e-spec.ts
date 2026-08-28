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
 * Service Requests module (M15a) end-to-end coverage:
 *  - Status transition guard: OPEN->ASSIGNED only via assign; ASSIGNED/IN_PROGRESS
 *    ->RESOLVED via resolve; RESOLVED->CLOSED via status; invalid transitions rejected
 *    (400) and persisted status unchanged.
 *  - SLA deadline computed from priority on create; COMPLIANCE auto-escalates to >= HIGH.
 *  - Comment authorization: requester, assignee, or manager can comment; unrelated
 *    employee gets 403.
 *  - View scoping: read-only employee sees only own requests; manager sees all.
 *    Cross-org 404.
 *  - Anonymous: isAnonymous stores no requester identity; rejected when org disables it.
 *
 * Runs against the real dev MySQL/Redis instance (same as `npm run start:dev`).
 */
describe('Service Requests module (e2e)', () => {
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
      const requests = await prisma.serviceRequest.findMany({
        where: { organizationId },
        select: { id: true },
      });
      const requestIds = requests.map((r) => r.id);

      await prisma.serviceRequestComment.deleteMany({
        where: { serviceRequestId: { in: requestIds } },
      });
      await prisma.serviceRequest.deleteMany({ where: { organizationId } });
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
    managerToken: string;
    managerUserId: string;
    employeeId: string;
    employeeToken: string;
    employeeUserId: string;
    otherEmployeeId: string;
    otherEmployeeToken: string;
    otherEmployeeUserId: string;
  }

  async function createOrgFixture(
    label: string,
    opts: { allowAnonymous?: boolean } = {},
  ): Promise<OrgFixture> {
    const slug = `sr-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: {
        name: `SR E2E ${label}`,
        slug,
        isActive: true,
        allowAnonymousServiceRequests: opts.allowAnonymous ?? true,
      },
    });
    createdOrgIds.push(org.id);

    const managerRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `sr-e2e-manager-${label}`,
        description: 'Manager role',
        permissions: ['service_request:read', 'service_request:create', 'service_request:manage'],
        isSystemRole: false,
      },
    });

    const employeeRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `sr-e2e-employee-${label}`,
        description: 'Requester-only role',
        permissions: ['service_request:read', 'service_request:create'],
        isSystemRole: false,
      },
    });

    const dept = await prisma.department.create({
      data: { organizationId: org.id, name: `Dept ${label}` },
    });
    const designation = await prisma.designation.create({
      data: { organizationId: org.id, departmentId: dept.id, name: `Designation ${label}` },
    });

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    async function makeUser(empCode: string, roleId: string, phone: string) {
      const employee = await prisma.employee.create({
        data: {
          organizationId: org.id,
          empCode,
          firstName: empCode,
          lastName: label,
          phone,
          departmentId: dept.id,
          designationId: designation.id,
          status: 'ACTIVE',
        },
      });
      const user = await prisma.user.create({
        data: {
          organizationId: org.id,
          employeeId: employee.id,
          email: `${empCode.toLowerCase()}-${label}@sr-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId } });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
      return {
        employeeId: employee.id,
        userId: user.id,
        token: login.body.data.accessToken as string,
      };
    }

    const manager = await makeUser(
      'MGR',
      managerRole.id,
      `9${label.length}${Date.now() % 100000}1`,
    );
    const emp = await makeUser('EMP', employeeRole.id, `9${label.length}${Date.now() % 100000}2`);
    const other = await makeUser(
      'OTHER',
      employeeRole.id,
      `9${label.length}${Date.now() % 100000}3`,
    );

    return {
      organizationId: org.id,
      managerToken: manager.token,
      managerUserId: manager.userId,
      employeeId: emp.employeeId,
      employeeToken: emp.token,
      employeeUserId: emp.userId,
      otherEmployeeId: other.employeeId,
      otherEmployeeToken: other.token,
      otherEmployeeUserId: other.userId,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  function createSR(token: string, organizationId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/service-requests')
      .set(authed(token, organizationId))
      .send(body);
  }

  // ─── SLA + priority escalation ──────────────────────────────────────────

  describe('SLA deadline + COMPLIANCE escalation', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('sla');
    });

    it('sets slaDeadline ~48h out for a HIGH priority IT request', async () => {
      const before = Date.now();
      const res = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Laptop not booting',
        description: 'Stopped booting since yesterday morning',
        priority: 'HIGH',
      }).expect(201);

      expect(res.body.data.priority).toBe('HIGH');
      const deadline = new Date(res.body.data.slaDeadline).getTime();
      const expected = before + 48 * 60 * 60 * 1000;
      expect(Math.abs(deadline - expected)).toBeLessThan(60 * 1000);
    });

    it('defaults to MEDIUM priority (+72h SLA) when priority omitted', async () => {
      const before = Date.now();
      const res = await createSR(org.employeeToken, org.organizationId, {
        category: 'HR',
        title: 'Payslip question',
        description: 'Need clarification on my payslip',
      }).expect(201);

      expect(res.body.data.priority).toBe('MEDIUM');
      const deadline = new Date(res.body.data.slaDeadline).getTime();
      const expected = before + 72 * 60 * 60 * 1000;
      expect(Math.abs(deadline - expected)).toBeLessThan(60 * 1000);
    });

    it('COMPLIANCE category auto-escalates a LOW-requested priority to HIGH with the escalated (48h) SLA', async () => {
      const before = Date.now();
      const res = await createSR(org.employeeToken, org.organizationId, {
        category: 'COMPLIANCE',
        title: 'Policy violation report',
        description: 'Reporting a possible compliance issue',
        priority: 'LOW',
      }).expect(201);

      expect(res.body.data.priority).toBe('HIGH');
      const deadline = new Date(res.body.data.slaDeadline).getTime();
      const expected = before + 48 * 60 * 60 * 1000;
      expect(Math.abs(deadline - expected)).toBeLessThan(60 * 1000);
    });

    it('COMPLIANCE category leaves an already-CRITICAL priority at CRITICAL (does not downgrade)', async () => {
      const res = await createSR(org.employeeToken, org.organizationId, {
        category: 'COMPLIANCE',
        title: 'Severe compliance issue',
        description: 'Urgent compliance matter',
        priority: 'CRITICAL',
      }).expect(201);

      expect(res.body.data.priority).toBe('CRITICAL');
    });
  });

  // ─── Status transition guard ────────────────────────────────────────────

  describe('Status transition guard', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('transitions');
    });

    it('rejects resolve on an OPEN request (must be ASSIGNED/IN_PROGRESS) and leaves status unchanged', async () => {
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Cannot resolve while open',
        description: 'placeholder description text',
      }).expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/resolve`)
        .set(authed(org.managerToken, org.organizationId))
        .send({})
        .expect(400);

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/service-requests/${id}`)
        .set(authed(org.managerToken, org.organizationId))
        .expect(200);
      expect(fetched.body.data.status).toBe('OPEN');
    });

    it('rejects OPEN -> CLOSED directly via the status endpoint', async () => {
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Cannot close while open',
        description: 'placeholder description text',
      }).expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/status`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ status: 'CLOSED' })
        .expect(400);

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/service-requests/${id}`)
        .set(authed(org.managerToken, org.organizationId))
        .expect(200);
      expect(fetched.body.data.status).toBe('OPEN');
    });

    it('walks the full valid chain: OPEN -> ASSIGNED (assign) -> IN_PROGRESS (status) -> RESOLVED (resolve) -> CLOSED (status)', async () => {
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Full lifecycle',
        description: 'placeholder description text',
      }).expect(201);
      const id = created.body.data.id;

      const assigned = await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/assign`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ assignedTo: org.managerUserId })
        .expect(200);
      expect(assigned.body.data.status).toBe('ASSIGNED');

      const inProgress = await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/status`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      expect(inProgress.body.data.status).toBe('IN_PROGRESS');

      const resolved = await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/resolve`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ resolutionNote: 'Fixed it' })
        .expect(200);
      expect(resolved.body.data.status).toBe('RESOLVED');
      expect(resolved.body.data.resolvedAt).not.toBeNull();

      const closed = await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/status`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ status: 'CLOSED' })
        .expect(200);
      expect(closed.body.data.status).toBe('CLOSED');
      expect(closed.body.data.closedAt).not.toBeNull();
    });

    it('rejects assigning an already-CLOSED request', async () => {
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Assign after closed',
        description: 'placeholder description text',
      }).expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/assign`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ assignedTo: org.managerUserId })
        .expect(200);
      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/resolve`)
        .set(authed(org.managerToken, org.organizationId))
        .send({})
        .expect(200);
      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/status`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ status: 'CLOSED' })
        .expect(200);

      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/assign`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ assignedTo: org.managerUserId })
        .expect(400);
    });
  });

  // ─── Comment authorization ───────────────────────────────────────────────

  describe('Comment authorization', () => {
    let org: OrgFixture;
    let requestId: string;

    beforeAll(async () => {
      org = await createOrgFixture('comments');
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Needs comments',
        description: 'placeholder description text',
      }).expect(201);
      requestId = created.body.data.id;
      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${requestId}/assign`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ assignedTo: org.otherEmployeeUserId })
        .expect(200);
    });

    it('the requester can comment', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/service-requests/${requestId}/comments`)
        .set(authed(org.employeeToken, org.organizationId))
        .send({ content: 'Any update?' })
        .expect(201);
    });

    it('the assignee can comment', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/service-requests/${requestId}/comments`)
        .set(authed(org.otherEmployeeToken, org.organizationId))
        .send({ content: 'Looking into it' })
        .expect(201);
    });

    it('a manager can comment', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/service-requests/${requestId}/comments`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ content: 'Escalating' })
        .expect(201);
    });

    it('an unrelated employee (not requester, assignee, or manager) gets 403', async () => {
      const unrelated = await createOrgFixture('comments-unrelated');
      // reuse the same org's request but authenticate as an employee from a fresh
      // fixture inside the SAME org context is not possible across orgs, so instead
      // create a genuinely unrelated employee within org itself.
      const role = await prisma.role.create({
        data: {
          organizationId: org.organizationId,
          name: `sr-e2e-unrelated-${uuid()}`,
          permissions: ['service_request:read', 'service_request:create'],
          isSystemRole: false,
        },
      });
      const dept = await prisma.department.findFirstOrThrow({
        where: { organizationId: org.organizationId },
      });
      const designation = await prisma.designation.findFirstOrThrow({
        where: { organizationId: org.organizationId },
      });
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const employee = await prisma.employee.create({
        data: {
          organizationId: org.organizationId,
          empCode: `UNREL-${uuid().slice(0, 6)}`,
          firstName: 'Unrelated',
          lastName: 'Person',
          phone: `9${Date.now() % 1000000000}`,
          departmentId: dept.id,
          designationId: designation.id,
          status: 'ACTIVE',
        },
      });
      const user = await prisma.user.create({
        data: {
          organizationId: org.organizationId,
          employeeId: employee.id,
          email: `unrelated-${uuid()}@sr-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/service-requests/${requestId}/comments`)
        .set(authed(login.body.data.accessToken, org.organizationId))
        .send({ content: 'Butting in' })
        .expect(403);

      void unrelated;
    });
  });

  // ─── View scoping ────────────────────────────────────────────────────────

  describe('View scoping', () => {
    let org: OrgFixture;
    let ownId: string;
    let othersId: string;

    beforeAll(async () => {
      org = await createOrgFixture('view-scoping');
      const own = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'My own request',
        description: 'placeholder description text',
      }).expect(201);
      ownId = own.body.data.id;

      const others = await createSR(org.otherEmployeeToken, org.organizationId, {
        category: 'HR',
        title: 'Someone else request',
        description: 'placeholder description text',
      }).expect(201);
      othersId = others.body.data.id;
    });

    it('a read-only employee sees only their own requests in the list', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/service-requests')
        .set(authed(org.employeeToken, org.organizationId))
        .query({ limit: 100 })
        .expect(200);
      const ids = res.body.data.data.map((r: { id: string }) => r.id);
      expect(ids).toContain(ownId);
      expect(ids).not.toContain(othersId);
    });

    it('a manager sees all requests in the list', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/service-requests')
        .set(authed(org.managerToken, org.organizationId))
        .query({ limit: 100 })
        .expect(200);
      const ids = res.body.data.data.map((r: { id: string }) => r.id);
      expect(ids).toContain(ownId);
      expect(ids).toContain(othersId);
    });

    it("a read-only employee gets 404 fetching someone else's request by id", async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/service-requests/${othersId}`)
        .set(authed(org.employeeToken, org.organizationId))
        .expect(404);
    });

    it('cross-org: a request never appears or is fetchable from a different org', async () => {
      const otherOrg = await createOrgFixture('view-scoping-cross-org');

      await request(app.getHttpServer())
        .get(`/api/v1/service-requests/${ownId}`)
        .set(authed(otherOrg.managerToken, otherOrg.organizationId))
        .expect(404);

      const list = await request(app.getHttpServer())
        .get('/api/v1/service-requests')
        .set(authed(otherOrg.managerToken, otherOrg.organizationId))
        .query({ limit: 100 })
        .expect(200);
      const ids = list.body.data.data.map((r: { id: string }) => r.id);
      expect(ids).not.toContain(ownId);
    });
  });

  // ─── Anonymous requests ──────────────────────────────────────────────────

  describe('Anonymous requests', () => {
    it('an anonymous request stores no employeeId and hides requester identity', async () => {
      const org = await createOrgFixture('anon-allowed', { allowAnonymous: true });
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'HR',
        title: 'Anonymous feedback',
        description: 'placeholder description text',
        isAnonymous: true,
      }).expect(201);

      expect(created.body.data.employeeId).toBeNull();
      expect(created.body.data.employee).toBeNull();
      expect(created.body.data.isAnonymous).toBe(true);

      const persisted = await prisma.serviceRequest.findUniqueOrThrow({
        where: { id: created.body.data.id },
      });
      expect(persisted.employeeId).toBeNull();
    });

    it('is rejected with 400 when the org disables allowAnonymousServiceRequests', async () => {
      const org = await createOrgFixture('anon-disabled', { allowAnonymous: false });
      await createSR(org.employeeToken, org.organizationId, {
        category: 'HR',
        title: 'Should be rejected',
        description: 'placeholder description text',
        isAnonymous: true,
      }).expect(400);
    });

    it('non-anonymous requests still work when allowAnonymousServiceRequests is false', async () => {
      const org = await createOrgFixture('anon-disabled-normal', { allowAnonymous: false });
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'HR',
        title: 'Normal request',
        description: 'placeholder description text',
      }).expect(201);
      expect(created.body.data.employeeId).toBe(org.employeeId);
    });

    it('GET /service-requests/settings exposes allowAnonymousServiceRequests to a plain requester (no org:read needed)', async () => {
      const orgDisabled = await createOrgFixture('anon-settings-disabled', {
        allowAnonymous: false,
      });
      const disabledRes = await request(app.getHttpServer())
        .get('/api/v1/service-requests/settings')
        .set(authed(orgDisabled.employeeToken, orgDisabled.organizationId))
        .expect(200);
      expect(disabledRes.body.data.allowAnonymousServiceRequests).toBe(false);

      const orgEnabled = await createOrgFixture('anon-settings-enabled', { allowAnonymous: true });
      const enabledRes = await request(app.getHttpServer())
        .get('/api/v1/service-requests/settings')
        .set(authed(orgEnabled.employeeToken, orgEnabled.organizationId))
        .expect(200);
      expect(enabledRes.body.data.allowAnonymousServiceRequests).toBe(true);
    });
  });

  // ─── Multi-tenancy sanity (permission strings) ──────────────────────────

  describe('Permission gating', () => {
    it('a service_request:read+create only user gets 403 assigning a request', async () => {
      const org = await createOrgFixture('permission-gating');
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Perm gating',
        description: 'placeholder description text',
      }).expect(201);

      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${created.body.data.id}/assign`)
        .set(authed(org.employeeToken, org.organizationId))
        .send({ assignedTo: org.employeeUserId })
        .expect(403);
    });
  });

  // ─── Maker-checker: self-approval guard (hrms-backend.md §26) ────────────

  describe('Maker-checker: self-resolve guard', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('self-approval');

      // Grant the requester's own user service_request:manage too, then
      // re-login to pick up the newly-flattened permission in the JWT.
      const managerRole = await prisma.role.findFirstOrThrow({
        where: { organizationId: org.organizationId, name: 'sr-e2e-manager-self-approval' },
      });
      await prisma.userRole.create({
        data: { userId: org.employeeUserId, roleId: managerRole.id },
      });
      const relogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `emp-self-approval@sr-e2e.test`, password: PASSWORD })
        .expect(200);
      org = { ...org, employeeToken: relogin.body.data.accessToken };
    });

    it('the requester, even holding service_request:manage, gets 403 resolving their own request', async () => {
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Self-resolve attempt',
        description: 'placeholder description text',
      }).expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/assign`)
        .set(authed(org.employeeToken, org.organizationId))
        .send({ assignedTo: org.employeeUserId })
        .expect(200);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/resolve`)
        .set(authed(org.employeeToken, org.organizationId))
        .send({ resolutionNote: 'Trying to resolve my own request' })
        .expect(403);
      expect(res.body.message).toMatch(/yourself/i);
    });

    it('a DIFFERENT user holding service_request:manage can resolve the same request normally', async () => {
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Resolved by a different user',
        description: 'placeholder description text',
      }).expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/assign`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ assignedTo: org.managerUserId })
        .expect(200);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/service-requests/${id}/resolve`)
        .set(authed(org.managerToken, org.organizationId))
        .send({ resolutionNote: 'Resolved normally' })
        .expect(200);
      expect(res.body.data.status).toBe('RESOLVED');
    });
  });

  // ─── Employee-less admin account guard (docs/known-issues.md 2026-08-28) ──
  //
  // Uses the REAL seeded iGreen Technologies org + admin@igreentec.in account
  // (employeeId: null), mirroring the established pattern in
  // permission-boundaries.e2e-spec.ts, rather than a synthetic fixture --
  // synthetic orgs have no employee-less user to exercise this guard with.
  // The org's `allowAnonymousServiceRequests` flag is read up front and
  // restored to its original value in afterAll so this suite never leaves
  // shared dev-DB state different from how it found it.
  describe('Employee-less admin account guard (create)', () => {
    let orgId: string;
    let adminToken: string;
    let targetEmployeeId: string;
    let leavePolicyTypeId: string;
    let originalAllowAnonymous: boolean;
    const createdRequestIds: string[] = [];

    beforeAll(async () => {
      const org = await prisma.organization.findFirst({
        where: { name: { contains: 'iGreen' } },
      });
      if (!org) throw new Error('Seeded iGreen Technologies org not found — run the seeders first');
      orgId = org.id;
      originalAllowAnonymous = org.allowAnonymousServiceRequests;
      if (!originalAllowAnonymous) {
        await prisma.organization.update({
          where: { id: orgId },
          data: { allowAnonymousServiceRequests: true },
        });
      }

      const adminUser = await prisma.user.findFirst({ where: { email: 'admin@igreentec.in' } });
      if (!adminUser) throw new Error('Seeded admin@igreentec.in not found — run the seeders first');
      if (adminUser.employeeId !== null) {
        throw new Error(
          'Seeded admin@igreentec.in unexpectedly has an employeeId — DB drift from the ' +
            'documented seed state (docs/known-issues.md 2026-08-18); this guard cannot be ' +
            'exercised against this account until reseeded.',
        );
      }

      const adminLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'admin@igreentec.in', password: 'Admin@1234' })
        .expect(200);
      adminToken = adminLogin.body.data.accessToken;

      const employee = await prisma.employee.findFirst({
        where: { organizationId: orgId, status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
      if (!employee) throw new Error('No active employee found in seeded iGreen org for SPECIAL_LEAVE target');
      targetEmployeeId = employee.id;

      const policyType = await prisma.leavePolicyType.findFirst({
        where: { leavePolicy: { organizationId: orgId, deletedAt: null } },
        select: { id: true },
      });
      if (!policyType) throw new Error('No leave policy type found in seeded iGreen org');
      leavePolicyTypeId = policyType.id;
    });

    afterAll(async () => {
      if (createdRequestIds.length) {
        await prisma.serviceRequestComment.deleteMany({
          where: { serviceRequestId: { in: createdRequestIds } },
        });
        await prisma.serviceRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
      }
      if (!originalAllowAnonymous) {
        await prisma.organization.update({
          where: { id: orgId },
          data: { allowAnonymousServiceRequests: false },
        });
      }
    });

    it('rejects a non-anonymous, non-SPECIAL_LEAVE request from an employee-less admin account with a 400 and the exact guard message', async () => {
      const res = await createSR(adminToken, orgId, {
        category: 'IT',
        title: 'Admin trying to self-raise',
        description: 'placeholder description text',
      }).expect(400);

      expect(res.body.message).toBe(
        'No employee record found for the current user — admin/non-employee accounts cannot ' +
          'raise a self-service request; use the anonymous option or have HR raise it on behalf ' +
          'of an employee via SPECIAL_LEAVE',
      );
    });

    it('still allows the employee-less admin account to raise an ANONYMOUS request', async () => {
      const res = await createSR(adminToken, orgId, {
        category: 'HR',
        title: 'Admin anonymous request',
        description: 'placeholder description text',
        isAnonymous: true,
      }).expect(201);

      createdRequestIds.push(res.body.data.id);
      expect(res.body.data.isAnonymous).toBe(true);
      expect(res.body.data.employeeId).toBeNull();
    });

    it('still allows the employee-less admin account to raise a SPECIAL_LEAVE request on behalf of a real employee', async () => {
      const res = await createSR(adminToken, orgId, {
        category: 'SPECIAL_LEAVE',
        title: 'Admin-filed special leave',
        description: 'placeholder description text',
        employeeId: targetEmployeeId,
        leavePolicyTypeId,
        leaveFromDate: '2026-09-01',
        leaveToDate: '2026-09-02',
        leaveDays: 2,
      }).expect(201);

      createdRequestIds.push(res.body.data.id);
      expect(res.body.data.category).toBe('SPECIAL_LEAVE');
      expect(res.body.data.employeeId).toBe(targetEmployeeId);
    });

    it('does not regress the primary path: a regular employee (non-null employeeId) can still raise a normal non-anonymous request', async () => {
      const org = await createOrgFixture('regular-employee-unaffected');
      const created = await createSR(org.employeeToken, org.organizationId, {
        category: 'IT',
        title: 'Normal employee request unaffected by the admin guard',
        description: 'placeholder description text',
      }).expect(201);

      expect(created.body.data.employeeId).toBe(org.employeeId);
      expect(created.body.data.isAnonymous).toBe(false);
    });
  });
});
