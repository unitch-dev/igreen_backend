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
 * Attendance-location-naming / OD-tracking / Casual-Leave-day-limit module
 * (see docs/known-issues.md 2026-08-14 entry) end-to-end coverage:
 *  - WorkLocation CRUD + org-scoping (org:read / org:update)
 *  - Haversine near/far resolution feeding AttendanceLog.checkInLocationName /
 *    checkOutLocationName
 *  - OD create + addLocation ACCUMULATES totalMinutes (sum, not overwrite)
 *  - GET /attendance/od manual permission gate: attendance:read sees all +
 *    filters, attendance:checkin-only sees self only
 *  - Casual Leave maxConsecutiveDays=1 rejects a 2-day application
 *
 * Runs against the real dev MySQL instance, same pattern as loans.e2e-spec.ts.
 */
describe('Work Locations + OD + Casual Leave limit (e2e)', () => {
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

      await prisma.odLocationEntry.deleteMany({
        where: { odRecord: { employeeId: { in: employeeIds } } },
      });
      await prisma.odRecord.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.attendanceLog.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveApplication.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leavePolicy.deleteMany({ where: { organizationId } });
      await prisma.workLocation.deleteMany({ where: { organizationId } });
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
    adminToken: string; // org:read + org:update + attendance:read + leave:apply
    employeeToken: string; // attendance:checkin only (+ leave:apply)
    employeeId: string;
    employee2Id: string;
    employee2Token: string; // second employee, attendance:checkin only
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `wl-od-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `WL-OD E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const adminRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `wl-od-e2e-admin-${label}`,
        description: 'Test admin role',
        permissions: [
          'org:read',
          'org:update',
          'attendance:read',
          'attendance:checkin',
          'leave:apply',
          'leave:read',
        ],
        isSystemRole: false,
      },
    });

    const employeeRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `wl-od-e2e-employee-${label}`,
        description: 'Test employee role (checkin-only, no attendance:read)',
        permissions: ['attendance:checkin', 'leave:apply'],
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

    const adminEmployee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `ADM-${label}`,
        firstName: 'Admin',
        lastName: label,
        phone: '9000000101',
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
        email: `admin-${label}@wl-od-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: adminUser.id, roleId: adminRole.id } });

    const employee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `EMP-${label}`,
        firstName: 'Applicant',
        lastName: label,
        phone: '9000000102',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });
    const employeeUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: employee.id,
        email: `employee-${label}@wl-od-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: employeeUser.id, roleId: employeeRole.id } });

    const employee2 = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `EMP2-${label}`,
        firstName: 'Second',
        lastName: label,
        phone: '9000000103',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });
    const employee2User = await prisma.user.create({
      data: {
        organizationId: org.id,
        employeeId: employee2.id,
        email: `employee2-${label}@wl-od-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: employee2User.id, roleId: employeeRole.id } });

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: PASSWORD })
      .expect(200);

    const employeeLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: employeeUser.email, password: PASSWORD })
      .expect(200);

    const employee2Login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: employee2User.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      departmentId: department.id,
      designationId: designation.id,
      adminToken: adminLogin.body.data.accessToken,
      employeeToken: employeeLogin.body.data.accessToken,
      employeeId: employee.id,
      employee2Id: employee2.id,
      employee2Token: employee2Login.body.data.accessToken,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  // ─── WorkLocation CRUD + org-scoping ──────────────────────────────────────

  describe('Work Locations CRUD + org-scoping', () => {
    let orgA: OrgFixture;
    let orgB: OrgFixture;
    let locationIdInA: string;

    beforeAll(async () => {
      orgA = await createOrgFixture('wl-a');
      orgB = await createOrgFixture('wl-b');
    });

    it('org:update caller creates a work location (201)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/work-locations')
        .set(authed(orgA.adminToken, orgA.organizationId))
        .send({
          name: 'HQ - Andheri',
          lat: 19.076,
          lng: 72.8777,
          radiusMeters: 200,
          isActive: true,
        })
        .expect(201);

      expect(res.body.data.name).toBe('HQ - Andheri');
      locationIdInA = res.body.data.id;
    });

    it('attendance:checkin-only caller (no org:read/org:update) is forbidden from creating/listing', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/work-locations')
        .set(authed(orgA.employeeToken, orgA.organizationId))
        .send({ name: 'Should Fail', lat: 1, lng: 1, radiusMeters: 100 })
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/v1/work-locations')
        .set(authed(orgA.employeeToken, orgA.organizationId))
        .expect(403);
    });

    it('org:read caller lists work locations (paginated)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/work-locations')
        .set(authed(orgA.adminToken, orgA.organizationId))
        .expect(200);

      expect(res.body.data.data.some((l: any) => l.id === locationIdInA)).toBe(true);
    });

    it('org:update caller updates a work location', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/work-locations/${locationIdInA}`)
        .set(authed(orgA.adminToken, orgA.organizationId))
        .send({ radiusMeters: 300 })
        .expect(200);

      expect(res.body.data.radiusMeters).toBe(300);
    });

    it('org B cannot read/update/delete org A work location (404, not leaked)', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/work-locations/${locationIdInA}`)
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(404);

      await request(app.getHttpServer())
        .put(`/api/v1/work-locations/${locationIdInA}`)
        .set(authed(orgB.adminToken, orgB.organizationId))
        .send({ radiusMeters: 999 })
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/work-locations/${locationIdInA}`)
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(404);

      // org B's own list never includes org A's location
      const list = await request(app.getHttpServer())
        .get('/api/v1/work-locations')
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(200);
      expect(list.body.data.data.some((l: any) => l.id === locationIdInA)).toBe(false);
    });

    it('org:update caller soft-deletes a work location', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/work-locations/${locationIdInA}`)
        .set(authed(orgA.adminToken, orgA.organizationId))
        .expect(200);
      expect(res.body.data.deleted).toBe(true);

      const list = await request(app.getHttpServer())
        .get('/api/v1/work-locations')
        .set(authed(orgA.adminToken, orgA.organizationId))
        .expect(200);
      expect(list.body.data.data.some((l: any) => l.id === locationIdInA)).toBe(false);
    });
  });

  // ─── Haversine near/far resolution on check-in ────────────────────────────

  describe('Check-in resolves work location name via haversine radius', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('haversine');
      await request(app.getHttpServer())
        .post('/api/v1/work-locations')
        .set(authed(org.adminToken, org.organizationId))
        .send({
          name: 'HQ - Andheri',
          lat: 19.076,
          lng: 72.8777,
          radiusMeters: 200,
          isActive: true,
        })
        .expect(201);
    });

    it('check-in within the radius resolves checkInLocationName to the matching location', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/attendance/check-in')
        .set(authed(org.employeeToken, org.organizationId))
        .send({ lat: 19.0761, lng: 72.8778 }) // ~15m away, well within 200m
        .expect(201);

      expect(res.body.data.checkInLocationName).toBe('HQ - Andheri');
    });

    it('check-in far outside every radius does NOT resolve to a real location name', async () => {
      // Different day/employee to avoid the "open log already exists" conflict
      const res = await request(app.getHttpServer())
        .post('/api/v1/attendance/check-in')
        .set(authed(org.employee2Token, org.organizationId))
        .send({ lat: 28.6139, lng: 77.209 }) // New Delhi — thousands of km away
        .expect(201);

      expect(res.body.data.checkInLocationName).not.toBe('HQ - Andheri');
      expect(res.body.data.checkInLocationName).toBe('Unrecognized Location');
    });

    it('check-out on the SAME day finds the open check-in log and resolves checkOutLocationName (regression for the @db.Date UTC-anchoring bug — see hrms-backend.md rule #19)', async () => {
      const checkIn = await request(app.getHttpServer())
        .post('/api/v1/attendance/check-in')
        .set(authed(org.adminToken, org.organizationId))
        .send({ lat: 19.0761, lng: 72.8778 })
        .expect(201);
      expect(checkIn.body.data.checkOutAt).toBeNull();

      const checkOut = await request(app.getHttpServer())
        .post('/api/v1/attendance/check-out')
        .set(authed(org.adminToken, org.organizationId))
        .send({ lat: 19.0761, lng: 72.8778 })
        .expect(201);

      expect(checkOut.body.data.id).toBe(checkIn.body.data.id); // same log, not a new one
      expect(checkOut.body.data.checkOutAt).not.toBeNull();
      expect(checkOut.body.data.checkOutLocationName).toBe('HQ - Andheri');
    });
  });

  // ─── OD accumulation + self vs all scoping ────────────────────────────────

  describe('OD multi-location minutes accumulation + GET /attendance/od scoping', () => {
    let org: OrgFixture;
    let odRecordId: string;

    beforeAll(async () => {
      org = await createOrgFixture('od-accum');
    });

    it("POST /attendance/od creates today's record with the first location entry + totalMinutes", async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/attendance/od')
        .set(authed(org.employeeToken, org.organizationId))
        .send({ lat: 19.2, lng: 72.9, minutes: 60, reason: 'Client site visit' })
        .expect(201);

      expect(res.body.data.totalMinutes).toBe(60);
      expect(res.body.data.entries).toHaveLength(1);
      odRecordId = res.body.data.id;
    });

    it('POST /attendance/od (same day, same employee) appends to the SAME record and ACCUMULATES minutes', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/attendance/od')
        .set(authed(org.employeeToken, org.organizationId))
        .send({ lat: 19.21, lng: 72.91, minutes: 30 })
        .expect(201);

      expect(res.body.data.id).toBe(odRecordId); // same today record, not a new one
      expect(res.body.data.totalMinutes).toBe(90); // 60 + 30, accumulated not overwritten
      expect(res.body.data.entries).toHaveLength(2);
    });

    it('POST /attendance/od/:id/locations appends a third entry and recomputes total as the SUM of all entries', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/attendance/od/${odRecordId}/locations`)
        .set(authed(org.employeeToken, org.organizationId))
        .send({ lat: 19.22, lng: 72.92, minutes: 45 })
        .expect(200);

      expect(res.body.data.totalMinutes).toBe(135); // 60 + 30 + 45
      expect(res.body.data.entries).toHaveLength(3);
    });

    it("another attendance:checkin-only employee cannot append to someone else's OD record (403)", async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/attendance/od/${odRecordId}/locations`)
        .set(authed(org.employee2Token, org.organizationId))
        .send({ lat: 1, lng: 1, minutes: 10 })
        .expect(403);
    });

    it('attendance:checkin-only caller sees only their own OD records on GET /attendance/od', async () => {
      // employee2 marks their own OD too
      await request(app.getHttpServer())
        .post('/api/v1/attendance/od')
        .set(authed(org.employee2Token, org.organizationId))
        .send({ lat: 5, lng: 5, minutes: 20 })
        .expect(201);

      const employeeView = await request(app.getHttpServer())
        .get('/api/v1/attendance/od')
        .set(authed(org.employeeToken, org.organizationId))
        .expect(200);

      expect(employeeView.body.data.data.length).toBe(1);
      expect(employeeView.body.data.data[0].employeeId).toBe(org.employeeId);
    });

    it('attendance:read caller sees ALL OD records org-wide, with ?employeeId= and ?date= filters working', async () => {
      const allView = await request(app.getHttpServer())
        .get('/api/v1/attendance/od')
        .set(authed(org.adminToken, org.organizationId))
        .expect(200);
      expect(allView.body.data.data.length).toBeGreaterThanOrEqual(2);

      const filteredView = await request(app.getHttpServer())
        .get('/api/v1/attendance/od')
        .set(authed(org.adminToken, org.organizationId))
        .query({ employeeId: org.employee2Id })
        .expect(200);
      expect(
        filteredView.body.data.data.every((rec: any) => rec.employeeId === org.employee2Id),
      ).toBe(true);
      expect(filteredView.body.data.data.length).toBe(1);

      const todayIso = new Date().toISOString().slice(0, 10);
      const dateFiltered = await request(app.getHttpServer())
        .get('/api/v1/attendance/od')
        .set(authed(org.adminToken, org.organizationId))
        .query({ date: todayIso })
        .expect(200);
      expect(dateFiltered.body.data.data.length).toBeGreaterThanOrEqual(2);
    });

    it('caller with neither attendance:read nor attendance:checkin is forbidden (403)', async () => {
      const bareRole = await prisma.role.create({
        data: {
          organizationId: org.organizationId,
          name: `wl-od-e2e-bare-${uuid()}`,
          permissions: ['employee:read'],
          isSystemRole: false,
        },
      });
      const bareEmployee = await prisma.employee.create({
        data: {
          organizationId: org.organizationId,
          empCode: `BARE-${uuid().slice(0, 6)}`,
          firstName: 'Bare',
          lastName: 'User',
          phone: '9000000199',
          departmentId: org.departmentId,
          designationId: org.designationId,
          status: 'ACTIVE',
        },
      });
      const passwordHash = await bcrypt.hash(PASSWORD, 10);
      const bareUser = await prisma.user.create({
        data: {
          organizationId: org.organizationId,
          employeeId: bareEmployee.id,
          email: `bare-${uuid()}@wl-od-e2e.test`,
          passwordHash,
          isActive: true,
        },
      });
      await prisma.userRole.create({ data: { userId: bareUser.id, roleId: bareRole.id } });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: bareUser.email, password: PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/attendance/od')
        .set(authed(login.body.data.accessToken, org.organizationId))
        .expect(403);
    });

    it("org B's attendance:read caller never sees org A's OD records, and org A record is not addressable (403, no leak) via addLocation from org B", async () => {
      const orgB = await createOrgFixture('od-accum-b');

      const list = await request(app.getHttpServer())
        .get('/api/v1/attendance/od')
        .set(authed(orgB.adminToken, orgB.organizationId))
        .expect(200);
      expect(list.body.data.data.some((rec: any) => rec.id === odRecordId)).toBe(false);

      // org B admin has attendance:read so hasReadPermission short-circuits the
      // employeeId ownership check in OdService.addLocation -- but the record
      // itself is scoped by organizationId in the initial findFirst, so a
      // cross-org id must still 404, not 403/200.
      await request(app.getHttpServer())
        .post(`/api/v1/attendance/od/${odRecordId}/locations`)
        .set(authed(orgB.adminToken, orgB.organizationId))
        .send({ lat: 1, lng: 1, minutes: 5 })
        .expect(404);
    });
  });

  // ─── OD create/addLocation with GPS coordinates omitted (0,0 fallback) ─────
  // See docs/known-issues.md 2026-08-31 entry: OD marking must not hard-fail
  // when the client has no GPS fix (denied permission, indoor signal loss).
  describe('OD create + addLocation succeed with lat/lng omitted (defaults to 0,0)', () => {
    let org: OrgFixture;

    beforeAll(async () => {
      org = await createOrgFixture('od-no-gps');
    });

    it('POST /attendance/od with lat/lng OMITTED succeeds and stores the entry as lat:0, lng:0', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/attendance/od')
        .set(authed(org.employeeToken, org.organizationId))
        .send({ minutes: 45, reason: 'Field visit, GPS denied' })
        .expect(201);

      expect(res.body.data.totalMinutes).toBe(45);
      expect(res.body.data.entries).toHaveLength(1);
      expect(res.body.data.entries[0].lat).toBe(0);
      expect(res.body.data.entries[0].lng).toBe(0);
    });

    it('POST /attendance/od/:id/locations with lat/lng OMITTED succeeds and stores the entry as lat:0, lng:0', async () => {
      const first = await request(app.getHttpServer())
        .get('/api/v1/attendance/od')
        .set(authed(org.employeeToken, org.organizationId))
        .expect(200);
      const odRecordId = first.body.data.data[0].id;

      const res = await request(app.getHttpServer())
        .post(`/api/v1/attendance/od/${odRecordId}/locations`)
        .set(authed(org.employeeToken, org.organizationId))
        .send({ minutes: 15 })
        .expect(200);

      expect(res.body.data.totalMinutes).toBe(60); // 45 + 15
      const newEntry = res.body.data.entries[res.body.data.entries.length - 1];
      expect(newEntry.lat).toBe(0);
      expect(newEntry.lng).toBe(0);
    });

    it('POST /attendance/od WITH real coordinates still stores the given lat/lng unchanged (no regression)', async () => {
      const otherOrg = await createOrgFixture('od-with-gps');
      const res = await request(app.getHttpServer())
        .post('/api/v1/attendance/od')
        .set(authed(otherOrg.employeeToken, otherOrg.organizationId))
        .send({ lat: 19.076, lng: 72.8777, minutes: 30 })
        .expect(201);

      expect(res.body.data.entries).toHaveLength(1);
      expect(res.body.data.entries[0].lat).toBe(19.076);
      expect(res.body.data.entries[0].lng).toBe(72.8777);
    });
  });

  // ─── Casual Leave day-limit fix ────────────────────────────────────────────

  describe('Casual Leave maxConsecutiveDays enforcement', () => {
    let org: OrgFixture;
    let casualPolicyTypeId: string;

    beforeAll(async () => {
      org = await createOrgFixture('casual-limit');

      const policy = await prisma.leavePolicy.create({
        data: {
          organizationId: org.organizationId,
          name: 'Casual Leave',
          isActive: true,
          types: {
            create: {
              leaveType: 'CASUAL',
              daysPerYear: 12,
              maxConsecutiveDays: 1,
              isLopEligible: true,
            },
          },
        },
        include: { types: true },
      });
      casualPolicyTypeId = policy.types[0].id;

      await prisma.leaveBalance.create({
        data: {
          employeeId: org.employeeId,
          leavePolicyTypeId: casualPolicyTypeId,
          year: new Date().getFullYear(),
          entitledDays: 12,
          takenDays: 0,
          balanceDays: 12,
        },
      });
    });

    it('rejects a 2-day Casual Leave application with a 400 when maxConsecutiveDays=1', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/leave/apply')
        .set(authed(org.employeeToken, org.organizationId))
        .send({
          leavePolicyTypeId: casualPolicyTypeId,
          fromDate: '2026-09-01',
          toDate: '2026-09-02',
          days: 2,
          reason: 'Long weekend',
        })
        .expect(400);

      expect(res.body.message).toContain('maximum of 1 consecutive day');
    });

    it('accepts a 1-day Casual Leave application (within the limit)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/leave/apply')
        .set(authed(org.employeeToken, org.organizationId))
        .send({
          leavePolicyTypeId: casualPolicyTypeId,
          fromDate: '2026-09-10',
          toDate: '2026-09-10',
          days: 1,
          reason: 'Personal errand',
        })
        .expect(201);

      expect(res.body.data.status).toBe('PENDING');
    });
  });
});
