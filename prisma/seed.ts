import { EmployeeStatus, EmploymentType, LeaveType, PrismaClient, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_DASHBOARDS } from '../src/modules/dashboard/dashboard.service';
import { PERMISSIONS, SYSTEM_ROLES } from '../src/common/constants/rbac.constant';

export { PERMISSIONS, SYSTEM_ROLES };

const prisma = new PrismaClient();

async function seedSubscriptionPlans(prisma: PrismaClient) {
  const plans = [
    {
      name: 'Starter',
      maxEmployees: 50,
      priceMonthly: 999,
      priceQuarterly: 2699,
      priceYearly: 9999,
      features: [
        'Up to 50 employees',
        'Basic HR features',
        'Leave management',
        'Attendance tracking',
      ],
      sortOrder: 1,
    },
    {
      name: 'Growth',
      maxEmployees: 200,
      priceMonthly: 2999,
      priceQuarterly: 7999,
      priceYearly: 29999,
      features: [
        'Up to 200 employees',
        'All Starter features',
        'Payroll management',
        'Performance reviews',
        'Advanced reports',
      ],
      sortOrder: 2,
    },
    {
      name: 'Enterprise',
      maxEmployees: -1,
      priceMonthly: 7999,
      priceQuarterly: 21999,
      priceYearly: 79999,
      features: [
        'Unlimited employees',
        'All Growth features',
        'Custom roles',
        'API access',
        'Priority support',
      ],
      sortOrder: 3,
    },
  ];

  for (const plan of plans) {
    await prisma.subscriptionPlan.upsert({
      where: { name: plan.name },
      update: {},
      create: { ...plan, features: plan.features as any },
    });
  }
  console.log('Subscription plans seeded');
}

async function seedSmsTemplates(prisma: PrismaClient) {
  const templates = [
    {
      key: 'otp',
      name: 'Login OTP',
      message: 'Your IGreen HRMS login OTP is: {{otp}}. Valid for 5 minutes.',
    },
    {
      key: 'onboardingWelcome',
      name: 'Onboarding Welcome (Portal)',
      message:
        "Welcome! Your Employee ID: {{empCode}}. Login: {{email}}, Temp Password: {{tempPassword}}. Change password on first login.",
    },
    {
      key: 'onboardingInvite',
      name: 'Onboarding Invite Link',
      message: "You've been invited to join the team. Complete your onboarding at: {{link}}",
    },
    {
      key: 'employeeInvite',
      name: 'Employee Invite (Direct Add)',
      message:
        'Welcome! Your Employee ID: {{empCode}}. Email: {{email}}, Temp Password: {{tempPassword}}. Change password on first login.',
    },
    {
      key: 'employeeWelcome',
      name: 'Employee Activation Welcome',
      message:
        'Welcome {{firstName}}! Your HRMS account ({{empCode}}) is now active. Login at: {{loginUrl}}',
    },
  ];

  for (const template of templates) {
    // update: {} — idempotent no-op so an admin's edited message/tid/senderId
    // survive reseed; only ever creates the row on first run.
    await prisma.smsTemplate.upsert({
      where: { key: template.key },
      update: {},
      create: {
        key: template.key,
        name: template.name,
        message: template.message,
        tid: null,
        senderId: null,
        isActive: true,
      },
    });
  }
  console.log('SMS templates seeded');
}

async function seedDefaultLeavePolicies(prisma: PrismaClient, organizationId: string) {
  const existingCasual = await prisma.leavePolicyType.findFirst({
    where: { leaveType: LeaveType.CASUAL, leavePolicy: { organizationId } },
  });

  if (existingCasual) {
    // Idempotent guard: only backfill maxConsecutiveDays if it was never set,
    // never overwrite an admin's already-configured value.
    if (existingCasual.maxConsecutiveDays === null) {
      await prisma.leavePolicyType.update({
        where: { id: existingCasual.id },
        data: { maxConsecutiveDays: 1 },
      });
      console.log('  Casual leave policy: backfilled maxConsecutiveDays=1');
    } else {
      console.log('  Casual leave policy already exists, skipping');
    }
    return;
  }

  await prisma.leavePolicy.create({
    data: {
      organizationId,
      name: 'Standard Policy',
      isActive: true,
      types: {
        create: {
          leaveType: LeaveType.CASUAL,
          name: 'Casual Leave',
          daysPerYear: 12,
          maxConsecutiveDays: 1,
          isLopEligible: true,
        },
      },
    },
  });
  console.log('  Casual leave policy created (maxConsecutiveDays=1)');
}

const KPI_TEMPLATES = [
  {
    title: 'Task Completion Rate',
    description: 'Percentage of assigned tasks completed on time',
    targetValue: 90,
    unit: '%',
  },
  {
    title: 'Attendance Punctuality',
    description: 'On-time check-in rate across the review period',
    targetValue: 95,
    unit: '%',
  },
  {
    title: 'Quality Score',
    description: 'Average quality rating from manager/peer review',
    targetValue: 4,
    unit: 'rating',
  },
];

async function seedDesignationKpis(prisma: PrismaClient, organizationId: string) {
  const designations = await prisma.designation.findMany({
    where: { organizationId, deletedAt: null },
    select: { id: true },
  });

  for (const designation of designations) {
    for (const template of KPI_TEMPLATES) {
      await prisma.kpi.upsert({
        where: {
          organizationId_designationId_title: {
            organizationId,
            designationId: designation.id,
            title: template.title,
          },
        },
        update: {},
        create: {
          organizationId,
          designationId: designation.id,
          title: template.title,
          description: template.description,
          targetValue: template.targetValue,
          unit: template.unit,
        },
      });
    }
  }
  console.log(`  Designation KPI templates seeded for ${designations.length} designation(s)`);
}

async function seedEmployeeKpis(prisma: PrismaClient, organizationId: string) {
  const employees = await prisma.employee.findMany({
    where: { organizationId, deletedAt: null },
    select: { id: true, designationId: true },
  });

  let assignedCount = 0;
  for (const employee of employees) {
    const kpis = await prisma.kpi.findMany({
      where: { organizationId, designationId: employee.designationId },
      select: { id: true },
    });

    for (const kpi of kpis) {
      await prisma.employeeKpi.upsert({
        where: { employeeId_kpiId: { employeeId: employee.id, kpiId: kpi.id } },
        update: {},
        create: {
          employeeId: employee.id,
          kpiId: kpi.id,
        },
      });
      assignedCount += 1;
    }
  }
  console.log(
    `  Employee KPI assignments backfilled: ${assignedCount} row(s) across ${employees.length} employee(s)`,
  );
}

/**
 * Idempotently seeds the role-default dashboards (DashboardConfig + widgets)
 * for an organization — mirrors DashboardService.seedDefaults() logic (kept
 * separate here because seed.ts runs as a standalone ts-node script against
 * a plain PrismaClient, not the NestJS-DI PrismaService). The widget data
 * itself is imported from dashboard.service.ts so there is a single source
 * of truth for DEFAULT_DASHBOARDS.
 */
function dashboardWidgetsMatchDefinition(
  existingWidgets: { widgetType: string; title: string; position: number; colSpan: number }[],
  defWidgets: { widgetType: string; title: string; position: number; colSpan: number }[],
): boolean {
  if (existingWidgets.length !== defWidgets.length) return false;

  return existingWidgets.every((w, i) => {
    const def = defWidgets[i];
    return (
      w.widgetType === def.widgetType &&
      w.title === def.title &&
      w.position === def.position &&
      w.colSpan === def.colSpan
    );
  });
}

async function seedDashboardDefaults(prisma: PrismaClient, organizationId: string) {
  let created = 0;
  let reconciled = 0;
  let unchanged = 0;

  for (const def of DEFAULT_DASHBOARDS) {
    const existing = await prisma.dashboardConfig.findFirst({
      where: { organizationId, roleName: def.roleName, isDefault: true },
      include: { widgets: { orderBy: { position: 'asc' } } },
    });

    if (existing) {
      const matches = dashboardWidgetsMatchDefinition(existing.widgets, def.widgets);

      if (matches && existing.name === def.name) {
        unchanged += 1;
        continue;
      }

      await prisma.dashboardWidget.deleteMany({ where: { dashboardId: existing.id } });
      await prisma.dashboardConfig.update({
        where: { id: existing.id },
        data: {
          name: def.name,
          widgets: {
            create: def.widgets.map((w) => ({
              widgetType: w.widgetType,
              title: w.title,
              position: w.position,
              colSpan: w.colSpan,
            })),
          },
        },
      });
      reconciled += 1;
      continue;
    }

    await prisma.dashboardConfig.create({
      data: {
        organizationId,
        name: def.name,
        roleName: def.roleName,
        isDefault: true,
        widgets: {
          create: def.widgets.map((w) => ({
            widgetType: w.widgetType,
            title: w.title,
            position: w.position,
            colSpan: w.colSpan,
          })),
        },
      },
    });
    created += 1;
  }

  console.log(
    `  Default dashboards seeded: ${created} created, ${reconciled} reconciled, ${unchanged} unchanged`,
  );
}

async function seedPlatformAdmin(prisma: PrismaClient) {
  const hash = await bcrypt.hash('', 10);
  await prisma.platformAdmin.upsert({
    where: { email: 'superadmin@platform.com' },
    update: {},
    create: {
      email: 'superadmin@platform.com',
      name: 'Super Admin',
      passwordHash: hash,
      isActive: true,
    },
  });
  console.log('Platform admin seeded');
}

/**
 * Dev dogfooding: seeds the iGreen org's `logoUrl` from the real logo asset
 * checked into the frontend (`frontend/src/assets/igreen-logo.png`), copied
 * onto local disk storage at the exact key/URL shape `FilesService.uploadLocal`
 * produces (`${appUrl}/uploads/organizations/<orgId>/logo.png`). Idempotent —
 * only copies the file / updates the row when they're not already correct.
 * This only applies when `STORAGE_DRIVER=local` (the active driver for this
 * dev environment); for `s3`, seeding a logo would require a real MinIO/S3
 * upload, which is out of scope for a DB/fixture seed and is skipped.
 */
async function seedOrgLogo(prismaClient: PrismaClient, organizationId: string): Promise<void> {
  const storageDriver = process.env.STORAGE_DRIVER || 's3';
  if (storageDriver !== 'local') {
    console.log('  Skipping org logo seed (STORAGE_DRIVER is not "local")');
    return;
  }

  const appUrl = process.env.APP_URL || 'http://localhost:3001';
  const localDir = process.env.STORAGE_LOCAL_DIR || 'uploads';
  const key = `organizations/${organizationId}/logo.png`;
  const destination = path.join(process.cwd(), localDir, key);
  const logoUrl = `${appUrl}/uploads/${key}`;

  const sourcePath = path.join(
    __dirname,
    '..',
    '..',
    'frontend',
    'src',
    'assets',
    'igreen-logo.png',
  );
  if (!fs.existsSync(sourcePath)) {
    console.log(`  Skipping org logo seed (source asset not found at ${sourcePath})`);
    return;
  }

  const destinationExists = fs.existsSync(destination);
  const sourceBuffer = fs.readFileSync(sourcePath);
  const destinationMatches = destinationExists && fs.readFileSync(destination).equals(sourceBuffer);

  if (!destinationMatches) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, sourceBuffer);
    console.log(`  Org logo copied to ${destination}`);
  }

  const org = await prismaClient.organization.findUnique({
    where: { id: organizationId },
    select: { logoUrl: true },
  });

  if (org?.logoUrl !== logoUrl) {
    await prismaClient.organization.update({
      where: { id: organizationId },
      data: { logoUrl },
    });
    console.log(`  Org logoUrl set to ${logoUrl}`);
  } else {
    console.log('  Org logoUrl already correct');
  }
}

/**
 * Links the seeded admin User to a real Employee record. Without this, the
 * admin account has User.employeeId === null, which trips guards like
 * green-thanks' "No employee record found for the current user" (rule #22).
 * Safe to re-run indefinitely: once adminUser.employeeId is set, this is a
 * no-op.
 */
async function seedAdminEmployee(
  prismaClient: PrismaClient,
  organizationId: string,
  adminUser: User,
) {
  if (adminUser.employeeId) {
    console.log('  Admin user already linked to an employee, skipping');
    return;
  }

  const department = await prismaClient.department.upsert({
    where: { organizationId_name: { organizationId, name: 'Administration' } },
    update: {},
    create: { organizationId, name: 'Administration' },
  });
  console.log(`  Department ready: ${department.name}`);

  let designation = await prismaClient.designation.findFirst({
    where: { organizationId, departmentId: department.id, name: 'Administrator' },
  });
  if (!designation) {
    designation = await prismaClient.designation.create({
      data: { organizationId, departmentId: department.id, name: 'Administrator' },
    });
    console.log(`  Designation created: ${designation.name}`);
  } else {
    console.log(`  Designation already exists: ${designation.name}`);
  }

  const employee = await prismaClient.employee.create({
    data: {
      organizationId,
      empCode: 'ADMIN-0001',
      firstName: 'Super',
      lastName: 'Admin',
      phone: adminUser.phone,
      email: adminUser.email,
      departmentId: department.id,
      designationId: designation.id,
      employmentType: EmploymentType.FULL_TIME,
      status: EmployeeStatus.ACTIVE,
      joiningDate: new Date(),
    },
  });
  console.log(`  Employee created: ${employee.empCode}`);

  await prismaClient.user.update({
    where: { id: adminUser.id },
    data: { employeeId: employee.id },
  });
  console.log(`  Linked admin user ${adminUser.email} to employee ${employee.empCode}`);
}

async function main() {
  console.log('Seeding database...');

  // Create default organization
  const org = await prisma.organization.upsert({
    where: { slug: 'igreen-technologies' },
    update: {},
    create: {
      name: 'IGreen Technologies',
      slug: 'igreen-technologies',
      email: 'admin@igreentec.in',
      isActive: true,
    },
  });
  console.log(`Organization: ${org.name} (${org.id})`);
  await seedOrgLogo(prisma, org.id);

  // Seed system roles
  for (const roleData of SYSTEM_ROLES) {
    const existing = await prisma.role.findFirst({
      where: { organizationId: org.id, name: roleData.name },
    });

    if (existing) {
      await prisma.role.update({
        where: { id: existing.id },
        data: { permissions: roleData.permissions, description: roleData.description },
      });
      console.log(`  Role updated: ${roleData.name}`);
    } else {
      await prisma.role.create({
        data: {
          organizationId: org.id,
          name: roleData.name,
          description: roleData.description,
          permissions: roleData.permissions,
          isSystemRole: true,
        },
      });
      console.log(`  Role created: ${roleData.name}`);
    }
  }

  // Create default super_admin user
  const superAdminRole = await prisma.role.findFirst({
    where: { organizationId: org.id, name: 'super_admin' },
  });

  const passwordHash = await bcrypt.hash('Admin@1234', 12);

  const adminUser = await prisma.user.upsert({
    where: {
      organizationId_email: { organizationId: org.id, email: 'admin@igreentec.in' },
    },
    update: {},
    create: {
      organizationId: org.id,
      email: 'admin@igreentec.in',
      phone: '9999999999',
      passwordHash,
      isActive: true,
    },
  });
  console.log(`Admin user: ${adminUser.email}`);

  // Assign super_admin role to admin user
  if (superAdminRole) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: adminUser.id, roleId: superAdminRole.id } },
      update: {},
      create: { userId: adminUser.id, roleId: superAdminRole.id },
    });
    console.log(`  Assigned super_admin role to ${adminUser.email}`);
  }

  await seedAdminEmployee(prisma, org.id, adminUser);

  await seedDefaultLeavePolicies(prisma, org.id);
  await seedDashboardDefaults(prisma, org.id);
  await seedSubscriptionPlans(prisma);
  await seedPlatformAdmin(prisma);
  await seedSmsTemplates(prisma);

  // KPI seeding must run after employees/designations exist (populated by
  // prisma/seed-employees-payroll.ts); both helpers are backfill-only/idempotent.
  await seedDesignationKpis(prisma, org.id);
  await seedEmployeeKpis(prisma, org.id);

  console.log('\nSeed complete.');
  console.log('Default login: admin@igreentec.in / Admin@1234');
  console.log('Platform admin: superadmin@platform.com / SuperAdmin@1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
