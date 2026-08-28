import { Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { BillingCycle } from '@prisma/client';
import { PrismaService } from '@prisma/prisma.service';
import { paginate, PaginationDto } from '@common/dto/pagination.dto';
import { SYSTEM_ROLES } from '@common/constants/rbac.constant';
import {
  RegisterOrganizationDto,
  UpdateOrganizationDto,
  UpdateSubscriptionDto,
} from './dto/register-organization.dto';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

@Injectable()
export class PlatformOrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async registerOrganization(dto: RegisterOrganizationDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Create organization
      const org = await tx.organization.create({
        data: {
          name: dto.name,
          slug: dto.slug ?? generateSlug(dto.name),
          logoUrl: dto.logoUrl,
          address: dto.address,
          email: dto.email,
          phone: dto.phone,
          isActive: true,
        },
      });

      // 2. Get plan
      const plan = await tx.subscriptionPlan.findUniqueOrThrow({
        where: { id: dto.planId },
      });

      // 3. Calculate period
      const now = new Date();
      const days =
        dto.billingCycle === 'MONTHLY' ? 30 : dto.billingCycle === 'QUARTERLY' ? 90 : 365;
      const periodEnd = new Date(now);
      periodEnd.setDate(periodEnd.getDate() + days);

      // 4. Create subscription
      const subscription = await tx.organizationSubscription.create({
        data: {
          organizationId: org.id,
          planId: plan.id,
          billingCycle: dto.billingCycle as BillingCycle,
          status: 'ACTIVE',
          gracePeriodDays: dto.gracePeriodDays ?? 7,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          nextBillingDate: periodEnd,
        },
      });

      // 5. Count existing invoices for numbering
      const invoiceCount = await tx.invoice.count();
      const year = now.getFullYear();
      const invoiceNumber = `INV-${year}-${String(invoiceCount + 1).padStart(5, '0')}`;

      // 6. Calculate amounts
      const taxPercent = dto.taxPercent ?? 18;
      const dueAfterDays = dto.dueAfterDays ?? 30;
      const amount =
        dto.billingCycle === 'MONTHLY'
          ? Number(plan.priceMonthly)
          : dto.billingCycle === 'QUARTERLY'
            ? Number(plan.priceQuarterly)
            : Number(plan.priceYearly);
      const taxAmount = (amount * taxPercent) / 100;
      const totalAmount = amount + taxAmount;

      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + dueAfterDays);

      // 7. Create invoice
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          organizationId: org.id,
          subscriptionId: subscription.id,
          amount,
          taxPercent,
          taxAmount,
          totalAmount,
          status: 'SENT',
          dueDate,
          periodStart: now,
          periodEnd,
        },
      });

      // 8. Seed roles for the new organization
      const createdRoles: Record<string, string> = {};
      for (const roleData of SYSTEM_ROLES) {
        const role = await tx.role.create({
          data: {
            organizationId: org.id,
            name: roleData.name,
            description: roleData.description,
            permissions: roleData.permissions,
            isSystemRole: true,
          },
        });
        createdRoles[roleData.name] = role.id;
      }

      // 9. Generate temp password
      const tempPassword = Math.random().toString(36).slice(-8).toUpperCase();
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      // 10. Create admin user
      const user = await tx.user.create({
        data: {
          organizationId: org.id,
          email: dto.adminEmail,
          passwordHash,
          mustChangePassword: true,
          isActive: true,
        },
      });

      // 11. Assign org_admin role
      const orgAdminRoleId = createdRoles['org_admin'];
      if (orgAdminRoleId) {
        await tx.userRole.create({
          data: {
            userId: user.id,
            roleId: orgAdminRoleId,
          },
        });
      }

      // 12. Link the admin user to a real Employee record (mirrors
      // prisma/seed.ts's seedAdminEmployee — see backend CLAUDE.md rule #22
      // / feedback_rbac_sync_on_new_features): without an Employee, guards
      // like green-thanks' "No employee record found for the current user"
      // fire for the org admin. This is a brand-new org, so no idempotency
      // check is needed here (always creates).
      const adminDepartment = await tx.department.create({
        data: { organizationId: org.id, name: 'Administration' },
      });
      const adminDesignation = await tx.designation.create({
        data: { organizationId: org.id, departmentId: adminDepartment.id, name: 'Administrator' },
      });
      const [adminFirstName, adminLastName] = dto.adminEmail.split('@')[0].split(/[._-]/);
      const adminEmployee = await tx.employee.create({
        data: {
          organizationId: org.id,
          empCode: 'ADMIN-0001',
          firstName: adminFirstName || 'Org',
          // Employee.lastName is required non-null; fall back to a generic
          // value when the local-part of the email has no separator.
          lastName: adminLastName || 'Admin',
          // Employee.phone is required non-null; dto.phone is optional for
          // org registration, so fall back to a clearly-fake placeholder.
          phone: dto.phone ?? '0000000000',
          email: dto.adminEmail,
          departmentId: adminDepartment.id,
          designationId: adminDesignation.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          joiningDate: now,
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { employeeId: adminEmployee.id },
      });

      return { organization: org, subscription, invoice, tempPassword };
    });
  }

  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.organization.findMany({
        skip,
        take: limit,
        include: {
          subscription: { include: { plan: true } },
          _count: { select: { employees: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.organization.count(),
    ]);
    const paginationDto = new PaginationDto();
    paginationDto.page = page;
    paginationDto.limit = limit;
    return paginate(data, total, paginationDto);
  }

  async findById(id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        subscription: { include: { plan: true } },
        _count: { select: { employees: true } },
      },
    });
    if (!org) throw new NotFoundException(`Organization ${id} not found`);
    return org;
  }

  async updateOrg(id: string, dto: UpdateOrganizationDto) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException(`Organization ${id} not found`);

    return this.prisma.organization.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
      },
    });
  }

  async suspend(id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException(`Organization ${id} not found`);

    await this.prisma.organization.update({
      where: { id },
      data: { isActive: false },
    });

    await this.prisma.organizationSubscription.updateMany({
      where: { organizationId: id },
      data: { status: 'SUSPENDED' },
    });

    return { message: 'Organization suspended' };
  }

  async activate(id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException(`Organization ${id} not found`);

    await this.prisma.organization.update({
      where: { id },
      data: { isActive: true },
    });

    await this.prisma.organizationSubscription.updateMany({
      where: { organizationId: id },
      data: { status: 'ACTIVE' },
    });

    return { message: 'Organization activated' };
  }

  async updateSubscription(id: string, dto: UpdateSubscriptionDto) {
    const sub = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId: id },
    });
    if (!sub) throw new NotFoundException(`Subscription for org ${id} not found`);

    return this.prisma.organizationSubscription.update({
      where: { organizationId: id },
      data: {
        ...(dto.planId !== undefined && { planId: dto.planId }),
        ...(dto.billingCycle !== undefined && {
          billingCycle: dto.billingCycle as BillingCycle,
        }),
      },
    });
  }
}
