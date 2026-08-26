/**
 * CSV employee/payroll upsert seeder.
 *
 * Reads `backend/prisma/data/salary_reportJanuary.csv` (a real client payroll
 * export) and writes Department / Designation / PayrollStructure / Employee /
 * User / UserRole rows directly via Prisma — bypassing CreateEmployeeDto.
 *
 * Upsert semantics per row (by empCode): inserts a new Employee/User/UserRole
 * if none exists yet; otherwise updates the existing Employee's fields and
 * self-heals a missing User link if one somehow wasn't created previously.
 * Safe to re-run any time the CSV changes.
 *
 * NOT a NestJS module/controller/endpoint. Run via:
 *   npm run seed:employees-payroll
 *
 * See docs/modules/csv-employee-payroll-seeder.md for the full design.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EmploymentType, EmployeeStatus, LeaveType, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const ORG_SLUG = 'igreen-technologies';
const CSV_PATH = path.join(__dirname, 'data', 'salary_reportJanuary.csv');
const REPORT_PATH = path.join(__dirname, 'data', 'import-report.md');
const PLACEHOLDER_PASSWORD = '123456';

// ─── Department mapping (from Designation column) ──────────────────────────
const DEPARTMENT_MAP: Record<string, string> = {
  'Company Director': 'Management',
  'Finance Head': 'Finance',
  'Accounts Assistant': 'Finance',
  'Bore Path Specialist': 'Execution',
  'Site Coordinator': 'Project',
  'Sr. Site Coordinator': 'Project',
  'CAD Designer': 'Project',
  Operator: 'Production Unit',
  Welder: 'Production Unit',
  'CNC Programmer': 'Production Unit',
  'CNC Operator': 'Production Unit',
  'VMC Operator': 'Production Unit',
  'Lathe Operator': 'Production Unit',
  Fitter: 'Production Unit',
  'Factory Coordinator': 'Production Unit',
  Driver: 'Admin Support',
  'Sr. Admin Executive': 'Admin Support',
  'Project Assistant': 'Admin Support',
  Executive: 'Admin Support',
  'Relationship Manager': 'Business Development',
  Trainee: 'Others',
  Helper: 'Labours',
};

interface CsvRow {
  rowIndex: number;
  empCode: string;
  empName: string;
  designation: string;
  basic: string;
  hra: string;
  specialAllowance: string;
  educationAllowance: string;
  total: string;
  pf: string;
  tax: string;
}

interface FlagEntry {
  empCode: string;
  detail: string;
}

interface ImportReport {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  skippedDetails: FlagEntry[];
  departmentMappingUsed: Set<string>;
  ambiguousEmpCode: FlagEntry[];
  nameSplitFlags: FlagEntry[];
  placeholderContactFlags: FlagEntry[];
  unknownJoiningDate: FlagEntry[];
  missingPayrollData: FlagEntry[];
}

function cleanText(value: string): string {
  return value
    .replace(/Â/g, '')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
}

function splitName(cleanedName: string): { firstName: string; lastName: string } {
  const lastSpaceIndex = cleanedName.lastIndexOf(' ');
  if (lastSpaceIndex === -1) {
    return { firstName: cleanedName, lastName: '' };
  }
  return {
    firstName: cleanedName.slice(0, lastSpaceIndex).trim(),
    lastName: cleanedName.slice(lastSpaceIndex + 1).trim(),
  };
}

function buildPlaceholderPhone(rowIndex: number): string {
  return '00000' + String(rowIndex).padStart(5, '0');
}

function buildPlaceholderEmail(empCode: string): string {
  const slug = empCode.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${slug}@igreentec.in`;
}

function parseCsv(raw: string): CsvRow[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const [, ...dataLines] = lines; // drop header

  return dataLines.map((line, idx) => {
    const cols = line.split(',');
    return {
      rowIndex: idx + 1,
      empCode: cols[0].trim(),
      empName: cols[1],
      designation: cols[2],
      basic: cols[4],
      hra: cols[5],
      specialAllowance: cols[6],
      educationAllowance: cols[7],
      total: cols[8],
      pf: cols[9],
      tax: cols[10],
    };
  });
}

async function resolveDepartment(
  organizationId: string,
  name: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  const existing = await prisma.department.findFirst({ where: { organizationId, name } });
  if (existing) {
    cache.set(name, existing.id);
    return existing.id;
  }

  const created = await prisma.department.create({
    data: { organizationId, name },
  });
  cache.set(name, created.id);
  return created.id;
}

async function resolveDesignation(
  organizationId: string,
  name: string,
  departmentId: string,
  cache: Map<string, string>,
): Promise<string> {
  const cacheKey = `${name}::${departmentId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const existing = await prisma.designation.findFirst({
    where: { organizationId, name, departmentId },
  });
  if (existing) {
    cache.set(cacheKey, existing.id);
    return existing.id;
  }

  const created = await prisma.designation.create({
    data: { organizationId, name, departmentId },
  });
  cache.set(cacheKey, created.id);
  return created.id;
}

interface SalaryComponent {
  name: string;
  type: 'FIXED';
  value: number;
  isDeductible: boolean;
}

async function resolvePayrollStructure(
  organizationId: string,
  empCode: string,
  row: CsvRow,
  report: ImportReport,
): Promise<string | null> {
  const isNaRow = [row.basic, row.hra, row.specialAllowance, row.educationAllowance, row.total, row.pf, row.tax]
    .map((v) => v.trim())
    .includes('NA');

  if (isNaRow) {
    report.missingPayrollData.push({ empCode, detail: 'Salary columns are NA in source CSV — no PayrollStructure created' });
    return null;
  }

  const columnDefs: Array<{ label: string; raw: string }> = [
    { label: 'Basic', raw: row.basic },
    { label: 'HRA', raw: row.hra },
    { label: 'Special Allowance', raw: row.specialAllowance },
    { label: 'Education Allowance', raw: row.educationAllowance },
  ];

  const components: SalaryComponent[] = columnDefs
    .map((col) => ({ name: col.label, value: parseInt(col.raw, 10) || 0 }))
    .filter((col) => col.value > 0)
    .map((col) => ({ name: col.name, type: 'FIXED', value: col.value, isDeductible: false }));

  const structureName = `${empCode} Salary Structure`;

  const existing = await prisma.payrollStructure.findFirst({
    where: { organizationId, name: structureName },
  });
  if (existing) {
    return existing.id;
  }

  const created = await prisma.payrollStructure.create({
    data: {
      organizationId,
      name: structureName,
      components: components as unknown as object,
      isActive: true,
    },
  });
  return created.id;
}

function newReport(): ImportReport {
  return {
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    skippedDetails: [],
    departmentMappingUsed: new Set<string>(),
    ambiguousEmpCode: [],
    nameSplitFlags: [],
    placeholderContactFlags: [],
    unknownJoiningDate: [],
    missingPayrollData: [],
  };
}

function writeReportFile(report: ImportReport): void {
  const lines: string[] = [];
  lines.push('# CSV Employee/Payroll Import Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total rows processed: ${report.totalRows}`);
  lines.push(`- Employees created: ${report.created}`);
  lines.push(`- Employees updated: ${report.updated}`);
  lines.push(`- Rows skipped: ${report.skipped}`);
  lines.push('');

  lines.push('## Skipped Rows');
  lines.push('');
  if (report.skippedDetails.length === 0) {
    lines.push('None.');
  } else {
    for (const item of report.skippedDetails) {
      lines.push(`- **${item.empCode}**: ${item.detail}`);
    }
  }
  lines.push('');

  lines.push('## Department Mapping Used');
  lines.push('');
  for (const [designation, department] of Object.entries(DEPARTMENT_MAP)) {
    if (report.departmentMappingUsed.has(designation)) {
      lines.push(`- ${designation} -> ${department}`);
    }
  }
  lines.push('');

  const flagSection = (title: string, entries: FlagEntry[]): void => {
    lines.push(`## ${title}`);
    lines.push('');
    if (entries.length === 0) {
      lines.push('None.');
    } else {
      for (const item of entries) {
        lines.push(`- **${item.empCode}**: ${item.detail}`);
      }
    }
    lines.push('');
  };

  flagSection('Ambiguous Emp Code (needs corrected emp code from client)', report.ambiguousEmpCode);
  flagSection('Uncertain Name Split', report.nameSplitFlags);
  flagSection('Placeholder Phone/Email', report.placeholderContactFlags);
  flagSection('Unknown Joining Date', report.unknownJoiningDate);
  flagSection('Missing Payroll Data (NA row)', report.missingPayrollData);

  fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Idempotently grants an ADDITIONAL manager-tier role to two of the seeded
 * employees (keeping their base `employee` role), so there are real test
 * logins for QA/manual testing of finance/manager-gated features
 * (payroll structure create, leave/todo approvals, etc.) without needing to
 * hand-create users. Safe to re-run — uses findFirst-else-create on
 * UserRole.
 */
async function seedManagerTestLogins(organizationId: string): Promise<void> {
  const grants: Array<{ email: string; roleName: string }> = [
    { email: 'ali1708@igreentec.in', roleName: 'finance_manager' },
    { email: 'aru1675@igreentec.in', roleName: 'dept_manager' },
  ];

  for (const grant of grants) {
    const user = await prisma.user.findFirst({
      where: { organizationId, email: grant.email },
    });
    if (!user) {
      console.log(`  [SKIP] manager-role grant — user ${grant.email} not found`);
      continue;
    }

    const role = await prisma.role.findFirst({
      where: { organizationId, name: grant.roleName },
    });
    if (!role) {
      console.log(`  [SKIP] manager-role grant — role "${grant.roleName}" not found`);
      continue;
    }

    const existingGrant = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: role.id },
    });
    if (existingGrant) {
      console.log(`  [OK] ${grant.email} already holds role "${grant.roleName}"`);
      continue;
    }

    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    console.log(`  [OK] Granted role "${grant.roleName}" to ${grant.email}`);
  }
}

async function main(): Promise<void> {
  console.log('Starting CSV employee/payroll import...');

  const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG } });
  if (!org) {
    throw new Error(
      `Organization with slug "${ORG_SLUG}" not found. Run "npm run prisma:seed" first, then re-run this script.`,
    );
  }

  const casualLeavePolicy = await prisma.leavePolicy.findFirst({
    where: { organizationId: org.id, types: { some: { leaveType: LeaveType.CASUAL } } },
  });
  if (!casualLeavePolicy) {
    throw new Error(
      `No Casual leave policy found for organization "${org.name}". Run "npm run prisma:seed" first, then re-run this script.`,
    );
  }

  const employeeRole = await prisma.role.findFirst({
    where: { organizationId: org.id, name: 'employee' },
  });
  if (!employeeRole) {
    throw new Error(
      `No seeded "employee" system role found for organization "${org.name}". Run "npm run prisma:seed" first, then re-run this script.`,
    );
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCsv(raw);

  const report = newReport();
  report.totalRows = rows.length;

  const departmentCache = new Map<string, string>();
  const designationCache = new Map<string, string>();
  const passwordHash = await bcrypt.hash(PLACEHOLDER_PASSWORD, 12);

  for (const row of rows) {
    const rawEmpCode = row.empCode;

    // Step 2: skip-and-flag ambiguous emp codes.
    if (rawEmpCode.startsWith('...')) {
      report.ambiguousEmpCode.push({
        empCode: rawEmpCode,
        detail: 'needs corrected emp code from client',
      });
      report.skipped += 1;
      report.skippedDetails.push({
        empCode: rawEmpCode,
        detail: 'ambiguous emp code — needs corrected emp code from client',
      });
      console.log(`  [SKIP] ${rawEmpCode} — needs corrected emp code from client`);
      continue;
    }

    const empCode = cleanText(rawEmpCode);
    const cleanedName = cleanText(row.empName);
    const designationName = cleanText(row.designation);
    const placeholderEmail = buildPlaceholderEmail(empCode);

    // NOTE: report flags (department mapping, name split, placeholder
    // contact, joining date, payroll NA) are computed for EVERY
    // non-ambiguous row below, regardless of whether this row goes on to
    // create a new Employee or update an existing one. This is deliberate:
    // the report must document the full per-row decision trail every time
    // it is regenerated, independent of whether the row was an insert or
    // an update.

    // Step 3: resolve/create Department + Designation (idempotent —
    // findFirst-else-create; safe to call even when the row will be skipped).
    const departmentName = DEPARTMENT_MAP[designationName];
    if (!departmentName) {
      throw new Error(
        `No department mapping found for designation "${designationName}" (empCode ${empCode}). Update DEPARTMENT_MAP.`,
      );
    }
    report.departmentMappingUsed.add(designationName);

    const departmentId = await resolveDepartment(org.id, departmentName, departmentCache);
    const designationId = await resolveDesignation(org.id, designationName, departmentId, designationCache);

    // Step 4: name split.
    const { firstName, lastName } = splitName(cleanedName);
    report.nameSplitFlags.push({
      empCode,
      detail: `"${cleanedName}" -> firstName="${firstName}", lastName="${lastName}" (last-space heuristic, unverified)`,
    });

    // Step 5: placeholder contact.
    const phone = buildPlaceholderPhone(row.rowIndex);
    report.placeholderContactFlags.push({
      empCode,
      detail: `placeholder phone="${phone}", placeholder email="${placeholderEmail}" — real contact info needed from client`,
    });

    // Step 6: payroll structure (idempotent — findFirst-else-create; safe
    // to call even when the row will be skipped, and needed for the
    // Missing Payroll Data (NA row) report flag to survive re-runs).
    const payrollStructureId = await resolvePayrollStructure(org.id, empCode, row, report);

    // Step 7 (joiningDate flag).
    report.unknownJoiningDate.push({ empCode, detail: 'joiningDate unknown from source CSV — left null' });

    // Step 9: upsert — if the Employee already exists (by empCode), update
    // its fields in place and self-heal a missing User link (the exact
    // cause of "No employee record found for the current user" on
    // employee-scoped routes); otherwise insert a brand-new Employee/User.
    const existingEmployee = await prisma.employee.findFirst({
      where: { organizationId: org.id, empCode },
    });
    if (existingEmployee) {
      await prisma.$transaction(async (tx) => {
        await tx.employee.update({
          where: { id: existingEmployee.id },
          data: {
            firstName,
            lastName,
            phone,
            email: placeholderEmail,
            departmentId,
            designationId,
            payrollStructureId,
            leavePolicyId: casualLeavePolicy.id,
            employmentType: EmploymentType.FULL_TIME,
            status: EmployeeStatus.ACTIVE,
          },
        });

        const linkedUser = await tx.user.findFirst({
          where: { employeeId: existingEmployee.id },
        });
        if (!linkedUser) {
          const emailTaken = await tx.user.findFirst({
            where: { organizationId: org.id, email: placeholderEmail },
          });
          if (!emailTaken) {
            const user = await tx.user.create({
              data: {
                organizationId: org.id,
                employeeId: existingEmployee.id,
                email: placeholderEmail,
                phone,
                passwordHash,
                mustChangePassword: true,
                isActive: true,
              },
            });
            await tx.userRole.create({ data: { userId: user.id, roleId: employeeRole.id } });
          }
        }
      });

      report.updated += 1;
      console.log(`  [UPDATE] ${empCode} — ${firstName} ${lastName} updated`);
      continue;
    }

    const existingUser = await prisma.user.findFirst({
      where: { organizationId: org.id, email: placeholderEmail },
    });
    if (existingUser) {
      report.skipped += 1;
      report.skippedDetails.push({
        empCode,
        detail: `User with email ${placeholderEmail} already exists — skipped to avoid partial-run duplication`,
      });
      console.log(`  [SKIP] ${empCode} — user ${placeholderEmail} already exists`);
      continue;
    }

    // Steps 7-8: create Employee + User + UserRole atomically.
    await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: {
          organizationId: org.id,
          empCode,
          firstName,
          lastName,
          phone,
          email: placeholderEmail,
          departmentId,
          designationId,
          payrollStructureId,
          leavePolicyId: casualLeavePolicy.id,
          employmentType: EmploymentType.FULL_TIME,
          status: EmployeeStatus.ACTIVE,
          joiningDate: null,
        },
      });

      const user = await tx.user.create({
        data: {
          organizationId: org.id,
          employeeId: employee.id,
          email: placeholderEmail,
          phone,
          passwordHash,
          mustChangePassword: true,
          isActive: true,
        },
      });

      await tx.userRole.create({
        data: { userId: user.id, roleId: employeeRole.id },
      });
    });

    report.created += 1;
    console.log(`  [OK] ${empCode} — ${firstName} ${lastName} created`);
  }

  writeReportFile(report);

  console.log('\nGranting manager/finance test-login roles...');
  await seedManagerTestLogins(org.id);

  console.log('\nImport complete.');
  console.log(`Total rows processed: ${report.totalRows}`);
  console.log(`Created: ${report.created}`);
  console.log(`Updated: ${report.updated}`);
  console.log(`Skipped: ${report.skipped}`);
  console.log(`Report written to: ${REPORT_PATH}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
