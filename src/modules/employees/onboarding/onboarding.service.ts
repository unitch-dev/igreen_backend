import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { EmployeeStatus, OnboardingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { assertValidTransition } from './onboarding-state.machine';
import { CreateOnboardingLinkDto } from '../dto/create-onboarding-link.dto';
import { SubmitDetailsDto } from '../dto/submit-details.dto';
import { RequestChangesDto } from '../dto/request-changes.dto';
import { ApproveOnboardingDto } from '../dto/approve-onboarding.dto';
import { PaginationDto, paginate } from '../../../common/dto/pagination.dto';
import { OnboardingLinkQueryDto } from '../dto/onboarding-link-query.dto';
import { LeaveBalanceService } from '../../leave/leave-balance.service';

interface SubmissionDetails {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  gender?: string;
  nationality?: string;
  phone?: string;
  personalEmail?: string;
  bloodGroup?: string;
  existingHealthIssues?: string;
  address?: object;
  emergencyContact?: object;
  previousEmployment?: object;
  referenceContacts?: object[];
  declarationAccepted: boolean;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  accountType: string;
}

interface SubmissionData {
  details?: SubmissionDetails;
  documents?: Array<{
    type: string;
    fileName: string;
    fileUrl: string;
    fileAssetId: string;
    uploadedAt: string;
  }>;
  completedSteps: string[];
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('onboarding') private readonly onboardingQueue: Queue,
    private readonly leaveBalanceService: LeaveBalanceService,
  ) {}

  // ── HR: Generate invite link ──────────────────────────────────────────────

  async createLink(organizationId: string, hrUserId: string, dto: CreateOnboardingLinkDto) {
    const token = randomBytes(24).toString('hex');
    const expiresInDays = dto.expiresInDays ?? 7;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    const link = await this.prisma.$transaction(async (tx) => {
      const created = await tx.onboardingLink.create({
        data: {
          organizationId,
          token,
          email: dto.email,
          phone: dto.phone,
          candidateName: dto.candidateName ?? null,
          expiresAt,
          status: OnboardingStatus.PENDING,
          jobTitle: dto.jobTitle ?? null,
          departmentName: dto.departmentName ?? null,
          workLocation: dto.workLocation ?? null,
          prefillJoiningDate: dto.prefillJoiningDate ? new Date(dto.prefillJoiningDate) : null,
          prefillEmploymentType: dto.prefillEmploymentType ?? null,
          createdById: hrUserId,
        },
      });
      await tx.onboardingTransition.create({
        data: {
          onboardingLinkId: created.id,
          fromStatus: OnboardingStatus.PENDING,
          toStatus: OnboardingStatus.PENDING,
          actorId: hrUserId,
          actorType: 'HR',
          notes: 'Onboarding link generated',
        },
      });
      return created;
    });

    // Enqueue invite notification (non-blocking)
    await this.onboardingQueue.add('onboarding.invite', {
      token,
      email: dto.email,
      phone: dto.phone,
      candidateName: dto.candidateName,
      expiresAt: expiresAt.toISOString(),
    });

    return link;
  }

  async findLinks(organizationId: string, query: OnboardingLinkQueryDto) {
    const where: Prisma.OnboardingLinkWhereInput = {
      organizationId,
      ...(query.status && { status: query.status }),
    };

    const [data, total] = await Promise.all([
      this.prisma.onboardingLink.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        select: {
          id: true,
          token: true,
          email: true,
          phone: true,
          candidateName: true,
          status: true,
          expiresAt: true,
          createdAt: true,
          employeeId: true,
        },
      }),
      this.prisma.onboardingLink.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async findLinkById(organizationId: string, id: string) {
    const link = await this.prisma.onboardingLink.findFirst({
      where: { id, organizationId },
      include: { transitions: { orderBy: { occurredAt: 'asc' } } },
    });
    if (!link) throw new NotFoundException('Onboarding link not found');
    return link;
  }

  // ── HR: Review actions ───────────────────────────────────────────────────

  async markUnderReview(organizationId: string, id: string, hrUserId: string) {
    const link = await this.getLink(organizationId, id);
    assertValidTransition(link.status, OnboardingStatus.UNDER_REVIEW);

    return this.transition(
      link.id,
      link.status,
      OnboardingStatus.UNDER_REVIEW,
      hrUserId,
      'HR',
      'HR opened submission for review',
    );
  }

  async requestChanges(
    organizationId: string,
    id: string,
    hrUserId: string,
    dto: RequestChangesDto,
  ) {
    const link = await this.getLink(organizationId, id);
    assertValidTransition(link.status, OnboardingStatus.CHANGES_REQUESTED);

    return this.transition(
      link.id,
      link.status,
      OnboardingStatus.CHANGES_REQUESTED,
      hrUserId,
      'HR',
      dto.notes,
      {
        reviewedById: hrUserId,
        reviewedAt: new Date(),
        hrNotes: dto.notes,
      },
    );
  }

  async reject(organizationId: string, id: string, hrUserId: string, dto: RequestChangesDto) {
    const link = await this.getLink(organizationId, id);
    assertValidTransition(link.status, OnboardingStatus.REJECTED);

    return this.transition(
      link.id,
      link.status,
      OnboardingStatus.REJECTED,
      hrUserId,
      'HR',
      dto.notes,
      {
        reviewedById: hrUserId,
        reviewedAt: new Date(),
        hrNotes: dto.notes,
      },
    );
  }

  async approve(organizationId: string, id: string, hrUserId: string, dto: ApproveOnboardingDto) {
    const link = await this.getLink(organizationId, id);
    assertValidTransition(link.status, OnboardingStatus.ACTIVATED);

    const submissionData = link.submissionData as unknown as SubmissionData;
    if (!submissionData?.completedSteps?.includes('details')) {
      throw new BadRequestException('Candidate has not completed the details step');
    }
    if (!submissionData?.completedSteps?.includes('documents')) {
      throw new BadRequestException('Candidate has not uploaded documents');
    }

    // Pre-activation validation (outside transaction for clarity)
    await this.validateActivationPayload(organizationId, dto);

    // EmpCode
    const empCode = await this.resolveEmpCode(organizationId, dto.empCode);

    const details = submissionData.details!;
    const joiningDate = new Date(dto.joiningDate);
    const employeeStatus =
      joiningDate <= new Date() ? EmployeeStatus.ACTIVE : EmployeeStatus.PRE_BOARDING;

    // Temp password
    const firstName = details.firstName ?? 'User';
    const { tempPassword, passwordHash } = await this.buildTempCredentials(firstName);

    // Activation transaction
    const { employee, user } = await this.prisma.$transaction(async (tx) => {
      const emp = await tx.employee.create({
        data: {
          organizationId,
          departmentId: dto.departmentId,
          designationId: dto.designationId,
          payrollStructureId: dto.payrollStructureId,
          leavePolicyId: dto.leavePolicyIds[0],
          empCode,
          firstName: details.firstName,
          lastName: details.lastName,
          dateOfBirth: details.dateOfBirth ? new Date(details.dateOfBirth) : null,
          gender: details.gender ?? null,
          phone: link.phone,
          email: link.email,
          nationality: details.nationality ?? null,
          workLocation: link.workLocation ?? null,
          bloodGroup: details.bloodGroup ?? null,
          healthInfo: details.existingHealthIssues
            ? ({ existingConditions: details.existingHealthIssues } as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          previousEmployment:
            (details.previousEmployment as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          referenceContacts:
            (details.referenceContacts as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          address: (details.address as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          emergencyContact: (details.emergencyContact as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          bankDetails: {
            bankName: details.bankName,
            accountNumber: details.accountNumber,
            ifscCode: details.ifscCode,
            accountType: details.accountType,
          },
          documents: (submissionData.documents ?? []) as Prisma.InputJsonValue,
          employmentType: dto.employmentType,
          status: employeeStatus,
          joiningDate,
          probationEndDate: dto.probationEndDate ? new Date(dto.probationEndDate) : null,
          reportingManagerId: dto.reportingManagerId ?? null,
          createdById: hrUserId,
        },
      });

      const usr = await tx.user.create({
        data: {
          organizationId,
          employeeId: emp.id,
          email: link.email,
          phone: link.phone,
          passwordHash,
          mustChangePassword: true,
          isActive: true,
        },
      });

      await tx.userRole.createMany({
        data: dto.roleIds.map((roleId) => ({ userId: usr.id, roleId })),
      });

      await tx.onboardingLink.update({
        where: { id: link.id },
        data: {
          status: OnboardingStatus.ACTIVATED,
          employeeId: emp.id,
          activatedById: hrUserId,
          activatedAt: new Date(),
          updatedById: hrUserId,
        },
      });

      await tx.onboardingTransition.create({
        data: {
          onboardingLinkId: link.id,
          fromStatus: link.status,
          toStatus: OnboardingStatus.ACTIVATED,
          actorId: hrUserId,
          actorType: 'HR',
          notes: `Employee ${empCode} created. Dept: ${dto.departmentId}, Roles: ${dto.roleIds.join(',')}`,
        },
      });

      return { employee: emp, user: usr };
    });

    // Initialize a LeaveBalance row for EVERY leave type inside EVERY
    // selected leave policy bundle — this is the real fix for the
    // "Insufficient leave balance" bug (see rule §1 / known-issues.md
    // 2026-08-20): LeaveBalanceService.initializeForEmployee was previously
    // never called from any code path. Balances are keyed off
    // LeavePolicyType (not LeavePolicy) since a bundle can contain multiple
    // leave types (CL + PL + SL, ...).
    const currentYear = new Date().getFullYear();
    const policyTypes = await this.prisma.leavePolicyType.findMany({
      where: { leavePolicyId: { in: dto.leavePolicyIds } },
      select: { id: true },
    });
    for (const policyType of policyTypes) {
      await this.leaveBalanceService.initializeForEmployee(employee.id, policyType.id, currentYear);
    }

    // After transaction: enqueue welcome email (non-blocking)
    await this.onboardingQueue.add('onboarding.welcome', {
      empCode: employee.empCode,
      firstName: employee.firstName,
      email: link.email,
      phone: link.phone,
      tempPassword,
    });

    return { activated: true, empCode: employee.empCode, employeeId: employee.id, userId: user.id };
  }

  async revokeLink(organizationId: string, id: string, hrUserId: string) {
    const link = await this.getLink(organizationId, id);
    if (
      !([OnboardingStatus.PENDING, OnboardingStatus.IN_PROGRESS] as OnboardingStatus[]).includes(
        link.status,
      )
    ) {
      throw new BadRequestException('Only PENDING or IN_PROGRESS links can be revoked');
    }

    return this.transition(
      link.id,
      link.status,
      OnboardingStatus.EXPIRED,
      hrUserId,
      'HR',
      'Revoked by HR',
    );
  }

  async resendInvite(organizationId: string, id: string, hrUserId: string) {
    const link = await this.getLink(organizationId, id);

    const allowedStatuses: OnboardingStatus[] = [
      OnboardingStatus.PENDING,
      OnboardingStatus.IN_PROGRESS,
      OnboardingStatus.CHANGES_REQUESTED,
    ];
    if (!allowedStatuses.includes(link.status)) {
      throw new BadRequestException(
        'Only pending, in-progress, or changes-requested invites can be resent',
      );
    }

    const isExpired = link.expiresAt < new Date();
    let expiresAt = link.expiresAt;

    if (isExpired) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await this.transition(
        link.id,
        link.status,
        link.status,
        hrUserId,
        'HR',
        'Invite resent by HR (expiry extended)',
        { expiresAt },
      );
    } else {
      await this.transition(
        link.id,
        link.status,
        link.status,
        hrUserId,
        'HR',
        'Invite resent by HR',
      );
    }

    await this.onboardingQueue.add('onboarding.invite', {
      token: link.token,
      email: link.email,
      phone: link.phone,
      candidateName: link.candidateName,
      expiresAt: expiresAt.toISOString(),
    });

    return this.getLink(organizationId, id);
  }

  // ── Candidate public: repopulate form ────────────────────────────────────

  async getPublicLink(token: string) {
    const link = await this.prisma.onboardingLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundException('Invalid onboarding link');

    if (
      (
        [
          OnboardingStatus.ACTIVATED,
          OnboardingStatus.REJECTED,
          OnboardingStatus.EXPIRED,
        ] as OnboardingStatus[]
      ).includes(link.status)
    ) {
      throw new GoneException(`This onboarding link is ${link.status.toLowerCase()}`);
    }

    // Auto-transition CHANGES_REQUESTED → IN_PROGRESS when candidate re-opens
    if (link.status === OnboardingStatus.CHANGES_REQUESTED) {
      if (link.expiresAt < new Date()) {
        throw new GoneException('This onboarding link has expired');
      }
      await this.transition(
        link.id,
        link.status,
        OnboardingStatus.IN_PROGRESS,
        null,
        'CANDIDATE',
        'Candidate re-opened link after changes requested',
      );
    }

    return {
      status: link.status,
      candidateName: link.candidateName,
      expiresAt: link.expiresAt,
      hrNotes: link.hrNotes,
      jobContext: {
        jobTitle: link.jobTitle,
        departmentName: link.departmentName,
        workLocation: link.workLocation,
        joiningDate: link.prefillJoiningDate,
        employmentType: link.prefillEmploymentType,
      },
      submissionData: link.submissionData ?? { completedSteps: [] },
    };
  }

  // ── Candidate public: submit personal + bank details ────────────────────

  async submitDetails(token: string, dto: SubmitDetailsDto) {
    const link = await this.prisma.onboardingLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundException('Invalid onboarding link');
    this.assertCandidateCanWrite(link.status, link.expiresAt);

    const isFirstCall = link.status === OnboardingStatus.PENDING;
    const existing = (link.submissionData ?? { completedSteps: [] }) as unknown as SubmissionData;

    const updatedData: SubmissionData = {
      ...existing,
      details: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        dateOfBirth: dto.dateOfBirth,
        gender: dto.gender,
        nationality: dto.nationality,
        phone: dto.phone,
        personalEmail: dto.personalEmail,
        bloodGroup: dto.bloodGroup,
        existingHealthIssues: dto.existingHealthIssues,
        address: dto.address as object,
        emergencyContact: dto.emergencyContact as object,
        previousEmployment: dto.previousEmployment as object,
        referenceContacts: dto.referenceContacts as object[],
        declarationAccepted: dto.declarationAccepted,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        ifscCode: dto.ifscCode,
        accountType: dto.accountType,
      },
      completedSteps: [...new Set([...(existing.completedSteps ?? []), 'details'])],
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.onboardingLink.update({
        where: { id: link.id },
        data: { submissionData: updatedData as unknown as Prisma.InputJsonValue },
      });

      if (isFirstCall) {
        await tx.onboardingLink.update({
          where: { id: link.id },
          data: { status: OnboardingStatus.IN_PROGRESS },
        });
        await tx.onboardingTransition.create({
          data: {
            onboardingLinkId: link.id,
            fromStatus: OnboardingStatus.PENDING,
            toStatus: OnboardingStatus.IN_PROGRESS,
            actorType: 'CANDIDATE',
            notes: 'Candidate started filling the form',
          },
        });
      }
    });

    return { saved: true, completedSteps: updatedData.completedSteps };
  }

  // ── Candidate public: upload documents + final submit ───────────────────

  /**
   * Validates the link + "details step completed" precondition WITHOUT
   * touching storage. MUST be called by the controller before any file is
   * uploaded to disk — validating business preconditions after the
   * (slow, external, non-transactional) upload has already happened wastes
   * the upload and turns unrelated infra failures into misleading 500s
   * instead of the intended clean 400 (see docs/known-issues.md 2026-08-15).
   */
  async assertCanSubmitDocuments(token: string): Promise<{ organizationId: string }> {
    const link = await this.prisma.onboardingLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundException('Invalid onboarding link');
    this.assertCandidateCanWrite(link.status, link.expiresAt);

    const existing = (link.submissionData ?? { completedSteps: [] }) as unknown as SubmissionData;
    if (!existing.completedSteps?.includes('details')) {
      throw new BadRequestException('Please complete personal details before uploading documents');
    }

    return { organizationId: link.organizationId };
  }

  async submitDocuments(
    token: string,
    documents: Array<{ type: string; fileName: string; fileUrl: string; fileAssetId: string }>,
    finalSubmit: boolean,
  ) {
    const link = await this.prisma.onboardingLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundException('Invalid onboarding link');
    this.assertCandidateCanWrite(link.status, link.expiresAt);

    const existing = (link.submissionData ?? { completedSteps: [] }) as unknown as SubmissionData;
    if (!existing.completedSteps?.includes('details')) {
      throw new BadRequestException('Please complete personal details before uploading documents');
    }

    const now = new Date().toISOString();
    const newDocs = documents.map((d) => ({ ...d, uploadedAt: now }));
    const merged = [...(existing.documents ?? []), ...newDocs];

    const completedSteps = finalSubmit
      ? [...new Set([...(existing.completedSteps ?? []), 'documents'])]
      : (existing.completedSteps ?? []);

    const updatedData: SubmissionData = { ...existing, documents: merged, completedSteps };

    await this.prisma.$transaction(async (tx) => {
      await tx.onboardingLink.update({
        where: { id: link.id },
        data: { submissionData: updatedData as unknown as Prisma.InputJsonValue },
      });

      if (finalSubmit) {
        assertValidTransition(link.status, OnboardingStatus.SUBMITTED);
        await tx.onboardingLink.update({
          where: { id: link.id },
          data: { status: OnboardingStatus.SUBMITTED, usedAt: new Date() },
        });
        await tx.onboardingTransition.create({
          data: {
            onboardingLinkId: link.id,
            fromStatus: link.status,
            toStatus: OnboardingStatus.SUBMITTED,
            actorType: 'CANDIDATE',
            notes: 'Candidate submitted all documents',
          },
        });
      }
    });

    return { saved: true, completedSteps, documentCount: merged.length };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async transition(
    linkId: string,
    from: OnboardingStatus,
    to: OnboardingStatus,
    actorId: string | null,
    actorType: string,
    notes?: string,
    extraLinkData?: Prisma.OnboardingLinkUpdateInput,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.onboardingLink.update({
        where: { id: linkId },
        data: { status: to, ...extraLinkData },
      });
      await tx.onboardingTransition.create({
        data: {
          onboardingLinkId: linkId,
          fromStatus: from,
          toStatus: to,
          actorId,
          actorType,
          notes,
        },
      });
      return updated;
    });
  }

  private async getLink(organizationId: string, id: string) {
    const link = await this.prisma.onboardingLink.findFirst({ where: { id, organizationId } });
    if (!link) throw new NotFoundException('Onboarding link not found');
    return link;
  }

  private assertCandidateCanWrite(status: OnboardingStatus, expiresAt: Date) {
    if (expiresAt < new Date()) throw new GoneException('This onboarding link has expired');
    const allowed: OnboardingStatus[] = [OnboardingStatus.PENDING, OnboardingStatus.IN_PROGRESS];
    if (!allowed.includes(status)) {
      throw new ForbiddenException(`Cannot edit form in status: ${status}`);
    }
  }

  private async validateActivationPayload(organizationId: string, dto: ApproveOnboardingDto) {
    const [dept, designation, roles, payroll, leavePolicies] = await Promise.all([
      this.prisma.department.findFirst({
        where: { id: dto.departmentId, organizationId, deletedAt: null },
      }),
      this.prisma.designation.findFirst({
        where: {
          id: dto.designationId,
          departmentId: dto.departmentId,
          organizationId,
          deletedAt: null,
        },
      }),
      this.prisma.role.findMany({ where: { id: { in: dto.roleIds }, organizationId } }),
      this.prisma.payrollStructure.findFirst({
        where: { id: dto.payrollStructureId, organizationId, deletedAt: null },
      }),
      this.prisma.leavePolicy.findMany({
        where: {
          id: { in: dto.leavePolicyIds },
          organizationId,
          isActive: true,
          deletedAt: null,
        },
      }),
    ]);

    if (!dept) throw new BadRequestException('Department not found in this organization');
    if (!designation)
      throw new BadRequestException('Designation not found in the given department');
    if (roles.length !== dto.roleIds.length)
      throw new BadRequestException('One or more roles not found in this organization');
    if (!payroll) throw new BadRequestException('Payroll structure not found in this organization');
    if (leavePolicies.length !== dto.leavePolicyIds.length)
      throw new BadRequestException(
        'One or more leave policies not found or inactive in this organization',
      );

    if (dto.reportingManagerId) {
      const manager = await this.prisma.employee.findFirst({
        where: {
          id: dto.reportingManagerId,
          organizationId,
          status: EmployeeStatus.ACTIVE,
          deletedAt: null,
        },
      });
      if (!manager) throw new BadRequestException('Reporting manager not found or not active');
    }
  }

  private async resolveEmpCode(organizationId: string, customCode?: string): Promise<string> {
    if (customCode) {
      const clash = await this.prisma.employee.findFirst({
        where: { organizationId, empCode: customCode },
      });
      if (clash) throw new ConflictException(`empCode ${customCode} is already in use`);
      return customCode;
    }
    const last = await this.prisma.employee.findFirst({
      where: { organizationId },
      orderBy: { empCode: 'desc' },
      select: { empCode: true },
    });
    const seq = last ? parseInt(last.empCode.replace(/\D/g, ''), 10) + 1 : 1;
    return `EMP-${String(seq).padStart(5, '0')}`;
  }

  private async buildTempCredentials(
    firstName: string,
  ): Promise<{ tempPassword: string; passwordHash: string }> {
    const digits = Math.floor(1000 + Math.random() * 9000);
    const prefix = firstName.slice(0, 3).replace(/[^a-zA-Z]/g, 'Usr');
    const tempPassword = `${prefix}@${digits}`;
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    return { tempPassword, passwordHash };
  }
}
