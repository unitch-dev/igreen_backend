import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { EmployeeStatus, FileEntityType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { RedisService } from '../../redis/redis.service';
import { ChatService } from '../chat/chat.service';
import { paginate } from '../../common/dto/pagination.dto';
import { resolveEmpCode } from './helpers/emp-code.helper';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { UpdateEmployeeSelfDto } from './dto/update-employee-self.dto';
import { PatchEmployeeStatusDto } from './dto/patch-employee-status.dto';
import { EmployeeQueryDto } from './dto/employee-query.dto';
import { UpdateBankDetailsDto } from './dto/update-bank-details.dto';
import { UpdateEmergencyContactDto } from './dto/update-emergency-contact.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';

const VALID_STATUS_TRANSITIONS: Record<EmployeeStatus, EmployeeStatus[]> = {
  [EmployeeStatus.PRE_BOARDING]: [EmployeeStatus.ACTIVE, EmployeeStatus.EXITED],
  [EmployeeStatus.ACTIVE]: [
    EmployeeStatus.ON_LEAVE,
    EmployeeStatus.SUSPENDED,
    EmployeeStatus.EXITED,
  ],
  [EmployeeStatus.ON_LEAVE]: [EmployeeStatus.ACTIVE, EmployeeStatus.EXITED],
  [EmployeeStatus.SUSPENDED]: [EmployeeStatus.ACTIVE, EmployeeStatus.EXITED],
  [EmployeeStatus.EXITED]: [],
};

const REASON_REQUIRED_TRANSITIONS: Array<[EmployeeStatus, EmployeeStatus]> = [
  [EmployeeStatus.ACTIVE, EmployeeStatus.SUSPENDED],
  [EmployeeStatus.ACTIVE, EmployeeStatus.EXITED],
  [EmployeeStatus.PRE_BOARDING, EmployeeStatus.EXITED],
];

const PASSWORD_RESET_TTL_SECONDS = 86400; // 24 hours

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly chatService: ChatService,
    @InjectQueue('employees') private readonly employeesQueue: Queue,
  ) {}

  async create(organizationId: string, dto: CreateEmployeeDto, createdById: string) {
    // TODO: same "LeaveBalance never initialized" bug as the onboarding-approve flow (see OnboardingService.approve) affects this direct-create path too — out of scope here, needs its own fix.
    // Validate dept, designation, payroll structure, leave policy, and optional manager all belong to this org
    const [dept, designation, payrollStructure, leavePolicy, manager] = await Promise.all([
      this.prisma.department.findFirst({
        where: { id: dto.departmentId, organizationId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.designation.findFirst({
        where: { id: dto.designationId, organizationId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.payrollStructure.findFirst({
        where: { id: dto.payrollStructureId, organizationId, deletedAt: null },
        select: { id: true },
      }),
      dto.leavePolicyId
        ? this.prisma.leavePolicy.findFirst({
            where: { id: dto.leavePolicyId, organizationId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(true),
      dto.reportingManagerId
        ? this.prisma.employee.findFirst({
            where: { id: dto.reportingManagerId, organizationId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(true),
    ]);

    if (!dept)
      throw new BadRequestException(
        `Department ${dto.departmentId} not found in this organization`,
      );
    if (!designation)
      throw new BadRequestException(
        `Designation ${dto.designationId} not found in this organization`,
      );
    if (!payrollStructure)
      throw new BadRequestException(
        `Payroll structure ${dto.payrollStructureId} not found in this organization`,
      );
    if (!leavePolicy)
      throw new BadRequestException(
        `Leave policy ${dto.leavePolicyId} not found in this organization`,
      );
    if (!manager)
      throw new BadRequestException(
        `Reporting manager ${dto.reportingManagerId} not found in this organization`,
      );

    // Check subscription employee limit
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { subscription: { include: { plan: true } } },
    });
    if (org?.subscription?.plan && org.subscription.plan.maxEmployees !== -1) {
      const empCount = await this.prisma.employee.count({
        where: { organizationId, deletedAt: null },
      });
      if (empCount >= org.subscription.plan.maxEmployees) {
        throw new ForbiddenException({
          code: 'EMPLOYEE_LIMIT_REACHED',
          limit: org.subscription.plan.maxEmployees,
          message: `Employee limit of ${org.subscription.plan.maxEmployees} reached. Please upgrade your plan.`,
        });
      }
    }

    const empCode = await resolveEmpCode(this.prisma, organizationId, dto.empCode);

    const digits = Math.floor(1000 + Math.random() * 9000);
    const prefix = dto.firstName.slice(0, 3);
    const tempPassword = `${prefix}@${digits}`;
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const employee = await this.prisma.$transaction(async (tx) => {
      const emp = await tx.employee.create({
        data: {
          organizationId,
          empCode,
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
          gender: dto.gender ?? null,
          departmentId: dto.departmentId,
          designationId: dto.designationId,
          payrollStructureId: dto.payrollStructureId,
          leavePolicyId: dto.leavePolicyId,
          employmentType: dto.employmentType,
          status: EmployeeStatus.PRE_BOARDING,
          joiningDate: new Date(dto.joiningDate),
          probationEndDate: dto.probationEndDate ? new Date(dto.probationEndDate) : null,
          reportingManagerId: dto.reportingManagerId ?? null,
          pfNumber: dto.pfNumber ?? null,
          esiNumber: dto.esiNumber ?? null,
          uanNumber: dto.uanNumber ?? null,
          createdById,
        },
      });

      await tx.user.create({
        data: {
          organizationId,
          employeeId: emp.id,
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          mustChangePassword: true,
          isActive: true,
        },
      });

      return emp;
    });

    const frontendUrl = this.config.get<string>('frontendUrl');
    await this.employeesQueue.add('employee.onboarding-invite', {
      employeeId: employee.id,
      email: dto.email,
      phone: dto.phone,
      firstName: dto.firstName,
      empCode,
      tempPassword,
      preboardingUrl: `${frontendUrl}/preboarding`,
    });

    return employee;
  }

  async getStats(organizationId: string) {
    const where = { organizationId, deletedAt: null };
    const [total, statusGroups, typeGroups, deptGroups] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.groupBy({
        by: ['status'],
        where,
        _count: { status: true },
      }),
      this.prisma.employee.groupBy({
        by: ['employmentType'],
        where,
        _count: { employmentType: true },
      }),
      this.prisma.department.findMany({
        where: { organizationId, deletedAt: null },
        select: {
          id: true,
          name: true,
          _count: { select: { employees: { where: { deletedAt: null } } } },
        },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of statusGroups) byStatus[g.status] = g._count.status;

    const byType: Record<string, number> = {};
    for (const g of typeGroups) byType[g.employmentType] = g._count.employmentType;

    const byDepartment = deptGroups.map((d) => ({
      id: d.id,
      name: d.name,
      count: d._count.employees,
    }));

    return { total, byStatus, byType, byDepartment };
  }

  async findAll(organizationId: string, query: EmployeeQueryDto) {
    const where: Prisma.EmployeeWhereInput = {
      organizationId,
      deletedAt: null,
      ...(query.status && { status: query.status }),
      ...(query.employmentType && { employmentType: query.employmentType }),
      ...(query.departmentId && { departmentId: query.departmentId }),
      ...(query.designationId && { designationId: query.designationId }),
      ...(query.search && {
        OR: [
          { firstName: { contains: query.search } },
          { lastName: { contains: query.search } },
          { email: { contains: query.search } },
          { empCode: { contains: query.search } },
          { phone: { contains: query.search } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        include: {
          department: { select: { id: true, name: true } },
          designation: { select: { id: true, name: true, level: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.employee.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async findOne(organizationId: string, id: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: {
        department: true,
        designation: true,
        reportingManager: {
          select: { id: true, empCode: true, firstName: true, lastName: true },
        },
        payrollStructure: { select: { id: true, name: true } },
        leavePolicy: { select: { id: true, name: true } },
        zone: { select: { id: true, name: true } },
        user: {
          select: {
            id: true,
            email: true,
            isActive: true,
            mustChangePassword: true,
            lastLoginAt: true,
          },
        },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  async update(organizationId: string, id: string, dto: UpdateEmployeeDto, updatedById: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    if (dto.departmentId) {
      const dept = await this.prisma.department.findFirst({
        where: { id: dto.departmentId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!dept)
        throw new BadRequestException(
          `Department ${dto.departmentId} not found in this organization`,
        );
    }

    if (dto.designationId) {
      const desig = await this.prisma.designation.findFirst({
        where: { id: dto.designationId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!desig)
        throw new BadRequestException(
          `Designation ${dto.designationId} not found in this organization`,
        );
    }

    if (dto.reportingManagerId) {
      const mgr = await this.prisma.employee.findFirst({
        where: { id: dto.reportingManagerId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!mgr)
        throw new BadRequestException(
          `Reporting manager ${dto.reportingManagerId} not found in this organization`,
        );
    }

    if (dto.payrollStructureId) {
      const structure = await this.prisma.payrollStructure.findFirst({
        where: { id: dto.payrollStructureId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!structure)
        throw new BadRequestException(
          `Payroll structure ${dto.payrollStructureId} not found in this organization`,
        );
    }

    if (dto.leavePolicyId) {
      const policy = await this.prisma.leavePolicy.findFirst({
        where: { id: dto.leavePolicyId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!policy)
        throw new BadRequestException(
          `Leave policy ${dto.leavePolicyId} not found in this organization`,
        );
    }

    if (dto.zoneId) {
      const zone = await this.prisma.zone.findFirst({
        where: { id: dto.zoneId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!zone) throw new BadRequestException(`Zone ${dto.zoneId} not found in this organization`);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.employee.update({
          where: { id },
          data: {
            ...(dto.firstName !== undefined && { firstName: dto.firstName }),
            ...(dto.lastName !== undefined && { lastName: dto.lastName }),
            ...(dto.email !== undefined && { email: dto.email }),
            ...(dto.phone !== undefined && { phone: dto.phone }),
            ...(dto.departmentId !== undefined && { departmentId: dto.departmentId }),
            ...(dto.designationId !== undefined && { designationId: dto.designationId }),
            ...(dto.payrollStructureId !== undefined && {
              payrollStructureId: dto.payrollStructureId,
            }),
            ...(dto.leavePolicyId !== undefined && { leavePolicyId: dto.leavePolicyId }),
            ...(dto.zoneId !== undefined && { zoneId: dto.zoneId }),
            ...(dto.workLocation !== undefined && { workLocation: dto.workLocation }),
            ...(dto.employmentType !== undefined && { employmentType: dto.employmentType }),
            ...(dto.joiningDate !== undefined && { joiningDate: new Date(dto.joiningDate) }),
            ...(dto.probationEndDate !== undefined && {
              probationEndDate: new Date(dto.probationEndDate),
            }),
            ...(dto.reportingManagerId !== undefined && {
              reportingManagerId: dto.reportingManagerId,
            }),
            ...(dto.dateOfBirth !== undefined && { dateOfBirth: new Date(dto.dateOfBirth) }),
            ...(dto.gender !== undefined && { gender: dto.gender }),
            ...(dto.nationality !== undefined && { nationality: dto.nationality }),
            ...(dto.bloodGroup !== undefined && { bloodGroup: dto.bloodGroup }),
            ...(dto.address !== undefined && {
              address: dto.address as unknown as Prisma.InputJsonValue,
            }),
            ...(dto.healthInfo !== undefined && {
              healthInfo: dto.healthInfo as unknown as Prisma.InputJsonValue,
            }),
            ...(dto.previousEmployment !== undefined && {
              previousEmployment: dto.previousEmployment as unknown as Prisma.InputJsonValue,
            }),
            ...(dto.referenceContacts !== undefined && {
              referenceContacts: dto.referenceContacts as unknown as Prisma.InputJsonValue,
            }),
            ...(dto.profilePhotoUrl !== undefined && { profilePhotoUrl: dto.profilePhotoUrl }),
            ...(dto.pfNumber !== undefined && { pfNumber: dto.pfNumber }),
            ...(dto.esiNumber !== undefined && { esiNumber: dto.esiNumber }),
            ...(dto.uanNumber !== undefined && { uanNumber: dto.uanNumber }),
            updatedById,
          },
        });

        // Keep the linked User's login-identity fields in sync with the
        // Employee record (source of truth) — see docs/known-issues.md
        // (2026-09-02, User/Employee contact-field drift).
        if (dto.phone !== undefined || dto.email !== undefined) {
          await tx.user.updateMany({
            where: { employeeId: id },
            data: {
              ...(dto.phone !== undefined && { phone: dto.phone }),
              ...(dto.email !== undefined && { email: dto.email }),
            },
          });
        }

        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email already in use by another account in this organization');
      }
      throw error;
    }
  }

  // Self-service update: an employee editing their own personal details.
  // `id` must equal the caller's own employeeId — enforced here, not left to
  // the frontend. The DTO structurally excludes the 5 admin-only fields.
  async updateSelf(
    organizationId: string,
    id: string,
    dto: UpdateEmployeeSelfDto,
    callerEmployeeId: string | null,
  ) {
    if (!callerEmployeeId || callerEmployeeId !== id) {
      throw new ForbiddenException('You can only update your own profile');
    }

    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.employee.update({
          where: { id },
          data: {
            ...(dto.dateOfBirth !== undefined && { dateOfBirth: new Date(dto.dateOfBirth) }),
            ...(dto.gender !== undefined && { gender: dto.gender }),
            ...(dto.nationality !== undefined && { nationality: dto.nationality }),
            ...(dto.bloodGroup !== undefined && { bloodGroup: dto.bloodGroup }),
            ...(dto.phone !== undefined && { phone: dto.phone }),
            ...(dto.email !== undefined && { email: dto.email }),
            ...(dto.address !== undefined && {
              address: dto.address as unknown as Prisma.InputJsonValue,
            }),
            ...(dto.healthInfo !== undefined && {
              healthInfo: dto.healthInfo as unknown as Prisma.InputJsonValue,
            }),
            ...(dto.previousEmployment !== undefined && {
              previousEmployment: dto.previousEmployment as unknown as Prisma.InputJsonValue,
            }),
            ...(dto.referenceContacts !== undefined && {
              referenceContacts: dto.referenceContacts as unknown as Prisma.InputJsonValue,
            }),
            ...(dto.profilePhotoUrl !== undefined && { profilePhotoUrl: dto.profilePhotoUrl }),
          },
        });

        // Keep the linked User's login-identity fields in sync with the
        // Employee record (source of truth) — see docs/known-issues.md
        // (2026-09-02, User/Employee contact-field drift).
        if (dto.phone !== undefined || dto.email !== undefined) {
          await tx.user.updateMany({
            where: { employeeId: id },
            data: {
              ...(dto.phone !== undefined && { phone: dto.phone }),
              ...(dto.email !== undefined && { email: dto.email }),
            },
          });
        }

        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email already in use by another account in this organization');
      }
      throw error;
    }
  }

  // Self-OR-admin gate for bank details, emergency contact, documents, and
  // profile photo: the caller may act on their own Employee record with no
  // special permission, or on any record if they hold `employee:update`.
  private assertSelfOrAdmin(
    callerEmployeeId: string | null | undefined,
    targetEmployeeId: string,
    callerPermissions: string[] | undefined,
    adminPermission = 'employee:update',
  ) {
    const isSelf = !!callerEmployeeId && callerEmployeeId === targetEmployeeId;
    const isAdmin = !!callerPermissions?.includes(adminPermission);
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException(
        `You can only manage your own record, or you need the '${adminPermission}' permission`,
      );
    }
  }

  async patchStatus(
    organizationId: string,
    id: string,
    dto: PatchEmployeeStatusDto,
    updatedById: string,
  ) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: {
        user: { select: { id: true, email: true } },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const allowed = VALID_STATUS_TRANSITIONS[employee.status];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Transition from ${employee.status} to ${dto.status} is not permitted`,
      );
    }

    const needsReason = REASON_REQUIRED_TRANSITIONS.some(
      ([from, to]) => from === employee.status && to === dto.status,
    );
    if (needsReason && !dto.reason) {
      throw new BadRequestException(`A reason is required when transitioning to ${dto.status}`);
    }

    const updated = await this.prisma.employee.update({
      where: { id },
      data: { status: dto.status, updatedById },
    });

    if (dto.status === EmployeeStatus.ACTIVE && employee.user) {
      const frontendUrl = this.config.get<string>('frontendUrl');
      await this.employeesQueue.add('employee.welcome', {
        employeeId: employee.id,
        email: employee.user.email,
        phone: employee.phone,
        firstName: employee.firstName,
        empCode: employee.empCode,
        loginUrl: `${frontendUrl}/login`,
      });
    }

    if (dto.status === EmployeeStatus.EXITED || dto.status === EmployeeStatus.SUSPENDED) {
      await this.chatService.revokeAllForEmployee(employee.id);
    }

    return updated;
  }

  async remove(organizationId: string, id: string, updatedById: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    await this.prisma.employee.update({
      where: { id },
      data: { deletedAt: new Date(), updatedById },
    });
    return { deleted: true, message: `Employee ${employee.empCode} deleted successfully` };
  }

  async restore(organizationId: string, id: string, updatedById: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: { not: null } },
    });
    if (!employee) throw new NotFoundException('Deleted employee not found');

    return this.prisma.employee.update({ where: { id }, data: { deletedAt: null, updatedById } });
  }

  async findTrashed(organizationId: string, query: EmployeeQueryDto) {
    const where: Prisma.EmployeeWhereInput = { organizationId, deletedAt: { not: null } };
    const [data, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        orderBy: { deletedAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.employee.count({ where }),
    ]);
    return paginate(data, total, query);
  }

  async updateBankDetails(
    organizationId: string,
    id: string,
    dto: UpdateBankDetailsDto,
    updatedById: string,
    callerEmployeeId?: string | null,
    callerPermissions?: string[],
  ) {
    this.assertSelfOrAdmin(callerEmployeeId, id, callerPermissions);

    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true, empCode: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    return this.prisma.employee.update({
      where: { id },
      data: { bankDetails: dto as unknown as Prisma.InputJsonValue, updatedById },
      select: { id: true, empCode: true, bankDetails: true },
    });
  }

  async updateEmergencyContact(
    organizationId: string,
    id: string,
    dto: UpdateEmergencyContactDto,
    updatedById: string,
    callerEmployeeId?: string | null,
    callerPermissions?: string[],
  ) {
    this.assertSelfOrAdmin(callerEmployeeId, id, callerPermissions);

    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true, empCode: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    return this.prisma.employee.update({
      where: { id },
      data: { emergencyContact: dto as unknown as Prisma.InputJsonValue, updatedById },
      select: { id: true, empCode: true, emergencyContact: true },
    });
  }

  async uploadDocument(
    organizationId: string,
    id: string,
    file: Express.Multer.File,
    dto: UploadDocumentDto,
    updatedById: string,
    callerEmployeeId?: string | null,
    callerPermissions?: string[],
  ) {
    this.assertSelfOrAdmin(callerEmployeeId, id, callerPermissions);

    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true, empCode: true, documents: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const asset = await this.files.upload({
      buffer: file.buffer,
      organizationId,
      entityType: FileEntityType.EMPLOYEE_DOCUMENT,
      entityId: id,
      category: dto.documentType,
      fileName: file.originalname,
      mimeType: file.mimetype,
      uploadedById: updatedById,
    });

    const existing = Array.isArray(employee.documents) ? (employee.documents as object[]) : [];
    const newEntry = {
      type: dto.documentType,
      fileName: asset.fileName,
      fileUrl: asset.url,
      fileAssetId: asset.id,
      notes: dto.notes ?? null,
      uploadedAt: new Date().toISOString(),
      uploadedBy: updatedById,
    };
    const updatedDocuments = [...existing, newEntry];

    await this.prisma.employee.update({
      where: { id },
      data: { documents: updatedDocuments as unknown as Prisma.InputJsonValue, updatedById },
    });

    return { fileUrl: asset.url, documents: updatedDocuments };
  }

  async uploadProfilePhoto(
    organizationId: string,
    id: string,
    file: Express.Multer.File,
    updatedById: string,
    callerEmployeeId?: string | null,
    callerPermissions?: string[],
  ) {
    this.assertSelfOrAdmin(callerEmployeeId, id, callerPermissions);

    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true, empCode: true, profilePhotoUrl: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const asset = await this.files.upload({
      buffer: file.buffer,
      organizationId,
      entityType: FileEntityType.EMPLOYEE_PROFILE_PHOTO,
      entityId: id,
      fileName: file.originalname,
      mimeType: file.mimetype,
      uploadedById: updatedById,
    });

    await this.prisma.employee.update({
      where: { id },
      data: { profilePhotoUrl: asset.url, updatedById },
    });

    // Best-effort: delete every prior EMPLOYEE_PROFILE_PHOTO FileAsset for
    // this employee — this is the actual fix for the old bug where the
    // previous photo was never unlinked from disk on re-upload.
    const priorAssets = await this.prisma.fileAsset.findMany({
      where: {
        organizationId,
        entityType: FileEntityType.EMPLOYEE_PROFILE_PHOTO,
        entityId: id,
        id: { not: asset.id },
      },
      select: { id: true },
    });
    for (const prior of priorAssets) {
      this.files.deleteFile(prior.id).catch(() => {});
    }

    return { profilePhotoUrl: asset.url };
  }

  async getSubordinates(organizationId: string, id: string, depth = 5) {
    const root = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: {
        id: true,
        empCode: true,
        firstName: true,
        lastName: true,
        department: { select: { name: true } },
        designation: { select: { name: true } },
      },
    });
    if (!root) throw new NotFoundException('Employee not found');

    type TreeNode = typeof root & { subordinates: TreeNode[] };
    const nodeMap = new Map<string, TreeNode>();
    nodeMap.set(root.id, { ...root, subordinates: [] });

    const visited = new Set<string>([root.id]);
    let queue = [root.id];
    let level = 0;

    while (queue.length > 0 && level < depth) {
      const children = await this.prisma.employee.findMany({
        where: { reportingManagerId: { in: queue }, organizationId, deletedAt: null },
        select: {
          id: true,
          empCode: true,
          firstName: true,
          lastName: true,
          reportingManagerId: true,
          department: { select: { name: true } },
          designation: { select: { name: true } },
        },
      });

      const nextQueue: string[] = [];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        const node: TreeNode = { ...child, subordinates: [] };
        nodeMap.set(child.id, node);
        const parent = nodeMap.get(child.reportingManagerId!);
        if (parent) parent.subordinates.push(node);
        nextQueue.push(child.id);
      }

      queue = nextQueue;
      level++;
    }

    return nodeMap.get(root.id);
  }

  async getReportingChain(organizationId: string, id: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: { id: true, reportingManagerId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const chain: object[] = [];
    const visited = new Set<string>([id]);
    let currentManagerId = employee.reportingManagerId;
    const MAX_HOPS = 20;

    while (currentManagerId && chain.length < MAX_HOPS) {
      if (visited.has(currentManagerId)) break; // cycle guard
      visited.add(currentManagerId);

      const manager = await this.prisma.employee.findFirst({
        where: { id: currentManagerId, organizationId, deletedAt: null },
        select: {
          id: true,
          empCode: true,
          firstName: true,
          lastName: true,
          reportingManagerId: true,
          department: { select: { name: true } },
          designation: { select: { name: true } },
        },
      });

      if (!manager) break;
      chain.push(manager);
      currentManagerId = manager.reportingManagerId;
    }

    return chain;
  }

  async sendPasswordResetEmail(organizationId: string, id: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    if (!employee.user)
      throw new BadRequestException('Employee does not have a linked user account');

    const token = crypto.randomBytes(32).toString('hex');
    await this.redis.set(`pwd-reset:${token}`, employee.user.id, PASSWORD_RESET_TTL_SECONDS);

    const frontendUrl = this.config.get<string>('frontendUrl');
    const resetLink = `${frontendUrl}/reset-password?token=${token}`;

    await this.employeesQueue.add('employee.password-reset', {
      userId: employee.user.id,
      email: employee.user.email,
      firstName: employee.firstName,
      resetLink,
    });

    return { sent: true, expiresIn: '24h' };
  }
}
