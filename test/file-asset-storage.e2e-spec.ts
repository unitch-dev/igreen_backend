import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor';
import { FilesService } from '../src/modules/files/files.service';

/**
 * FileAsset storage refactor (see docs/modules/file-asset-storage-refactor.md):
 *  - S3/MinIO removed; local disk + the `FileAsset` Prisma model is now the
 *    single source of truth for uploaded-file lookup/delete.
 *  - CORE BUG FIX under test: EmployeesService.uploadProfilePhoto previously
 *    used a broken extractMinioKey() that never matched local-disk URLs, so
 *    re-uploading a photo silently orphaned the old file on disk. This spec
 *    proves the old FileAsset row AND its disk file are both gone after a
 *    re-upload.
 *  - Folder convention: uploads/{entityType}/{organizationId}/{entityId ??
 *    'unassigned'}/{uuid}-{fileName}.
 *  - deleteFile() is a hard-delete and a no-op (no throw) on a missing row.
 */
describe('FileAsset storage refactor (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const localDir = path.join(process.cwd(), 'uploads');

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

      await prisma.fileAsset.deleteMany({ where: { organizationId } });
      await prisma.onboardingTransition.deleteMany({
        where: { onboardingLink: { organizationId } },
      });
      await prisma.onboardingLink.deleteMany({ where: { organizationId } });
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
    adminToken: string;
    employeeId: string;
  }

  async function createOrgFixture(label: string): Promise<OrgFixture> {
    const slug = `file-asset-e2e-${label}-${uuid()}`;
    const org = await prisma.organization.create({
      data: { name: `File Asset E2E ${label}`, slug, isActive: true },
    });
    createdOrgIds.push(org.id);

    const adminRole = await prisma.role.create({
      data: {
        organizationId: org.id,
        name: `file-asset-e2e-admin-${label}`,
        description: 'Test admin role',
        permissions: ['employee:update', 'employee:read'],
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
        phone: '9100000001',
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
        email: `admin-${label}@file-asset-e2e.test`,
        passwordHash,
        isActive: true,
      },
    });
    await prisma.userRole.create({ data: { userId: adminUser.id, roleId: adminRole.id } });

    const targetEmployee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        empCode: `TGT-${label}`,
        firstName: 'Target',
        lastName: label,
        phone: '9100000002',
        departmentId: department.id,
        designationId: designation.id,
        payrollStructureId: payrollStructure.id,
        status: 'ACTIVE',
      },
    });

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: PASSWORD })
      .expect(200);

    return {
      organizationId: org.id,
      adminToken: adminLogin.body.data.accessToken,
      employeeId: targetEmployee.id,
    };
  }

  function authed(token: string, organizationId: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Organization-ID': organizationId,
    };
  }

  // Minimal valid 1x1 PNGs (distinct bytes so re-upload produces a different file).
  const PNG_A = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const PNG_B = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  async function fileExists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(path.join(localDir, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  describe('Multer validation (rule §27 — every upload endpoint must allowlist mimetype + cap size)', () => {
    it('rejects a non-image profile-photo upload with 400', async () => {
      const org = await createOrgFixture('photo-badtype');
      await request(app.getHttpServer())
        .post(`/api/v1/employees/${org.employeeId}/profile-photo`)
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', Buffer.from('not an image'), {
          filename: 'evil.exe',
          contentType: 'application/x-msdownload',
        })
        .expect(400);
    });

    it('rejects an oversized profile-photo upload', async () => {
      const org = await createOrgFixture('photo-toobig');
      const oversized = Buffer.alloc(6 * 1024 * 1024, 1);
      await request(app.getHttpServer())
        .post(`/api/v1/employees/${org.employeeId}/profile-photo`)
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', oversized, { filename: 'huge.png', contentType: 'image/png' })
        .expect((res) => {
          expect([400, 413]).toContain(res.status);
        });
    });

    it('rejects a disallowed mimetype document upload with 400', async () => {
      const org = await createOrgFixture('doc-badtype');
      await request(app.getHttpServer())
        .post(`/api/v1/employees/${org.employeeId}/documents`)
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', Buffer.from('not a document'), {
          filename: 'evil.exe',
          contentType: 'application/x-msdownload',
        })
        .field('documentType', 'OTHER')
        .expect(400);
    });
  });

  describe('CORE BUG FIX: profile photo re-upload actually unlinks the old file', () => {
    it('creates a new FileAsset, deletes the old disk file, and hard-deletes the old row', async () => {
      const org = await createOrgFixture('photo-reupload');

      const first = await request(app.getHttpServer())
        .post(`/api/v1/employees/${org.employeeId}/profile-photo`)
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', PNG_A, 'first.png')
        .expect(200);

      expect(first.body.data.profilePhotoUrl).toContain('EMPLOYEE_PROFILE_PHOTO');

      const firstAsset = await prisma.fileAsset.findFirst({
        where: {
          organizationId: org.organizationId,
          entityType: 'EMPLOYEE_PROFILE_PHOTO',
          entityId: org.employeeId,
        },
      });
      expect(firstAsset).toBeTruthy();
      expect(await fileExists(firstAsset!.filePath)).toBe(true);

      // Re-upload — this is the actual bug fix under test.
      const second = await request(app.getHttpServer())
        .post(`/api/v1/employees/${org.employeeId}/profile-photo`)
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', PNG_B, 'second.png')
        .expect(200);

      expect(second.body.data.profilePhotoUrl).not.toBe(first.body.data.profilePhotoUrl);

      const employee = await prisma.employee.findUnique({ where: { id: org.employeeId } });
      expect(employee!.profilePhotoUrl).toBe(second.body.data.profilePhotoUrl);

      const secondAsset = await prisma.fileAsset.findFirst({
        where: {
          organizationId: org.organizationId,
          entityType: 'EMPLOYEE_PROFILE_PHOTO',
          entityId: org.employeeId,
        },
      });
      expect(secondAsset).toBeTruthy();
      expect(secondAsset!.id).not.toBe(firstAsset!.id);
      expect(await fileExists(secondAsset!.filePath)).toBe(true);

      // The old FileAsset delete is fire-and-forget in the service (best
      // effort, does not block the response) — poll briefly for it to land.
      const oldRowGone = await pollUntil(
        async () => (await prisma.fileAsset.findUnique({ where: { id: firstAsset!.id } })) === null,
      );
      expect(oldRowGone).toBe(true);

      const oldFileGone = await pollUntil(async () => !(await fileExists(firstAsset!.filePath)));
      expect(oldFileGone).toBe(true);

      // Exactly one EMPLOYEE_PROFILE_PHOTO FileAsset should remain for this employee.
      const remaining = await prisma.fileAsset.findMany({
        where: {
          organizationId: org.organizationId,
          entityType: 'EMPLOYEE_PROFILE_PHOTO',
          entityId: org.employeeId,
        },
      });
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe(secondAsset!.id);
    }, 20000);
  });

  describe('Upload metadata + folder-path tagging', () => {
    it('employee document upload lands at the tagged folder path with correct FileAsset metadata', async () => {
      const org = await createOrgFixture('doc-metadata');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/employees/${org.employeeId}/documents`)
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', PNG_A, 'aadhaar.png')
        .field('documentType', 'AADHAAR')
        .field('notes', 'test doc')
        .expect(200);

      expect(res.body.data.fileUrl).toContain(
        `EMPLOYEE_DOCUMENT/${org.organizationId}/${org.employeeId}/`,
      );

      const asset = await prisma.fileAsset.findFirst({
        where: {
          organizationId: org.organizationId,
          entityType: 'EMPLOYEE_DOCUMENT',
          entityId: org.employeeId,
        },
      });
      expect(asset).toBeTruthy();
      expect(asset!.category).toBe('AADHAAR');
      expect(asset!.fileName).toBe('aadhaar.png');
      expect(asset!.mimeType).toBe('image/png');
      expect(asset!.sizeBytes).toBe(PNG_A.length);
      expect(asset!.uploadedById).toBeTruthy();
      expect(asset!.url).toBe(res.body.data.fileUrl);
      expect(await fileExists(asset!.filePath)).toBe(true);

      // The document array entry threads the fileAssetId through.
      const employee = await prisma.employee.findUnique({ where: { id: org.employeeId } });
      const docs = employee!.documents as unknown as Array<{ fileAssetId?: string }>;
      expect(docs.some((d) => d.fileAssetId === asset!.id)).toBe(true);
    });
  });

  describe('deleteFile()', () => {
    it('removes both the disk file and the DB row', async () => {
      const org = await createOrgFixture('delete-both');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/employees/${org.employeeId}/profile-photo`)
        .set(authed(org.adminToken, org.organizationId))
        .attach('file', PNG_A, 'to-delete.png')
        .expect(200);

      const asset = await prisma.fileAsset.findFirst({
        where: {
          organizationId: org.organizationId,
          entityType: 'EMPLOYEE_PROFILE_PHOTO',
          entityId: org.employeeId,
        },
      });
      expect(asset).toBeTruthy();
      expect(await fileExists(asset!.filePath)).toBe(true);
      expect(res.body.data.profilePhotoUrl).toBe(asset!.url);

      const filesService = app.get(FilesService);
      await filesService.deleteFile(asset!.id);

      expect(await fileExists(asset!.filePath)).toBe(false);
      const gone = await prisma.fileAsset.findUnique({ where: { id: asset!.id } });
      expect(gone).toBeNull();
    });

    it('is a no-op (does not throw) when the FileAsset row is already gone', async () => {
      const filesService = app.get(FilesService);
      await expect(filesService.deleteFile(uuid())).resolves.toBeUndefined();
    });
  });

  describe('Multi-tenancy: FileAsset lookups are scoped to organizationId', () => {
    it('an org-A profile photo FileAsset never resolves under org-B scoping', async () => {
      const orgA = await createOrgFixture('tenant-a');
      const orgB = await createOrgFixture('tenant-b');

      await request(app.getHttpServer())
        .post(`/api/v1/employees/${orgA.employeeId}/profile-photo`)
        .set(authed(orgA.adminToken, orgA.organizationId))
        .attach('file', PNG_A, 'a.png')
        .expect(200);

      const crossOrgLookup = await prisma.fileAsset.findFirst({
        where: {
          organizationId: orgB.organizationId,
          entityType: 'EMPLOYEE_PROFILE_PHOTO',
          entityId: orgA.employeeId,
        },
      });
      expect(crossOrgLookup).toBeNull();

      const orgAAssets = await prisma.fileAsset.findMany({
        where: { organizationId: orgA.organizationId },
      });
      expect(orgAAssets.length).toBeGreaterThan(0);
      const orgBAssets = await prisma.fileAsset.findMany({
        where: { organizationId: orgB.organizationId },
      });
      expect(orgBAssets.length).toBe(0);
    });
  });

  describe('Onboarding-public submitDocuments (no authenticated user)', () => {
    it('creates a FileAsset with entityId undefined (bucketed under unassigned), uploadedById undefined, tagged ONBOARDING_DOCUMENT', async () => {
      const slug = `file-asset-e2e-onboarding-${uuid()}`;
      const org = await prisma.organization.create({
        data: { name: 'File Asset E2E Onboarding', slug, isActive: true },
      });
      createdOrgIds.push(org.id);

      const token = require('crypto').randomBytes(24).toString('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      const link = await prisma.onboardingLink.create({
        data: {
          organizationId: org.id,
          token,
          email: 'candidate@file-asset-e2e.test',
          phone: '9876543210',
          candidateName: 'Candidate Onboarding',
          expiresAt,
          status: 'PENDING',
        },
      });

      await request(app.getHttpServer())
        .put(`/api/v1/onboarding/public/${link.token}/details`)
        .send({
          firstName: 'Asha',
          lastName: 'Verma',
          dateOfBirth: '1996-05-10',
          gender: 'FEMALE',
          address: {
            line1: '221B Baker Street',
            city: 'Pune',
            state: 'Maharashtra',
            pincode: '411001',
          },
          declarationAccepted: true,
          bankName: 'HDFC Bank',
          accountNumber: '123456789012',
          ifscCode: 'HDFC0001234',
          accountType: 'SAVINGS',
        })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/onboarding/public/${link.token}/documents`)
        .attach('files', Buffer.from('%PDF-1.4 minimal'), {
          filename: 'resume.pdf',
          contentType: 'application/pdf',
        })
        .field('documentTypes', 'RESUME')
        .field('finalSubmit', 'false')
        .expect(200);

      const asset = await prisma.fileAsset.findFirst({
        where: { organizationId: org.id, entityType: 'ONBOARDING_DOCUMENT' },
      });
      expect(asset).toBeTruthy();
      expect(asset!.entityId).toBeNull();
      expect(asset!.uploadedById).toBeNull();
      expect(asset!.category).toBe('RESUME');
      expect(asset!.filePath).toContain(`ONBOARDING_DOCUMENT/${org.id}/unassigned/`);
      expect(await fileExists(asset!.filePath)).toBe(true);

      // Response is a summary (saved/completedSteps/documentCount) — the
      // fileAssetId is threaded through OnboardingLink.submissionData.documents,
      // not echoed back directly on this endpoint's response body.
      expect(res.body.data.documentCount).toBe(1);

      const updatedLink = await prisma.onboardingLink.findUnique({ where: { id: link.id } });
      const submissionData = updatedLink?.submissionData as {
        documents?: Array<{ fileAssetId?: string }>;
      } | null;
      expect(submissionData?.documents?.some((d) => d.fileAssetId === asset!.id)).toBe(true);
    });
  });

  /** Polls `check` every 100ms up to ~3s for the fire-and-forget deleteFile() calls to land. */
  async function pollUntil(check: () => Promise<boolean>): Promise<boolean> {
    const attempts = 30;
    for (let i = 0; i < attempts; i++) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return check();
  }
});
