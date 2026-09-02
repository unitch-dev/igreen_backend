/**
 * Idempotent backfill: repair drifted User.phone / User.email columns.
 *
 * `Employee.phone`/`Employee.email` and the linked `User.phone`/`User.email`
 * are separate columns. Before the fix in
 * `src/modules/employees/employees.service.ts` (`update()`/`updateSelf()`),
 * editing an employee's phone/email only touched the `Employee` row, never
 * the linked `User` row — so OTP login (keyed on `User.phone`) and password
 * login (keyed on `User.email`) could silently go stale after any contact
 * edit. See docs/known-issues.md (2026-09-02, User/Employee contact-field
 * drift) for the full root-cause writeup.
 *
 * This script repairs already-drifted rows on a live DB. `Employee` is
 * treated as the source of truth: for every `User` with a non-null
 * `employeeId`, if `User.phone !== Employee.phone` or
 * `User.email !== Employee.email`, the `User` row is updated to match.
 *
 * `Employee.email` is nullable; `User.email` is not. To avoid nulling out a
 * working login email, email sync is SKIPPED (and logged) whenever
 * `Employee.email` is null — only phone is synced in that case.
 *
 * Idempotent: a second run finds zero drifted rows.
 *
 * NOT a NestJS module/controller/endpoint. Run via:
 *   npm run backfill:user-contact-sync
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { employeeId: { not: null } },
    select: {
      id: true,
      phone: true,
      email: true,
      employee: {
        select: { id: true, empCode: true, phone: true, email: true },
      },
    },
  });

  let fixedCount = 0;
  let skippedNullEmailCount = 0;

  for (const user of users) {
    const employee = user.employee;
    if (!employee) continue; // unique FK guarantees this, guard for TS narrowing only

    const phoneDrifted = user.phone !== employee.phone;
    const emailDrifted = employee.email !== null && user.email !== employee.email;
    const emailNullSkip = employee.email === null && user.email !== null;

    if (emailNullSkip) {
      skippedNullEmailCount += 1;
      console.log(
        `[SKIP email] empCode=${employee.empCode} Employee.email is null; ` +
          `leaving User.email="${user.email}" untouched to avoid breaking login`,
      );
    }

    if (!phoneDrifted && !emailDrifted) continue;

    const updateData: { phone?: string; email?: string } = {};
    if (phoneDrifted) updateData.phone = employee.phone;
    if (emailDrifted) updateData.email = employee.email as string;

    await prisma.user.update({ where: { id: user.id }, data: updateData });

    fixedCount += 1;
    console.log(
      `[FIXED] empCode=${employee.empCode} ` +
        `phone: "${user.phone}" -> "${phoneDrifted ? employee.phone : user.phone}", ` +
        `email: "${user.email}" -> "${emailDrifted ? employee.email : user.email}"`,
    );
  }

  console.log('---');
  console.log(`Checked ${users.length} User rows with a linked Employee.`);
  console.log(`Fixed ${fixedCount} drifted row(s).`);
  console.log(
    `Skipped ${skippedNullEmailCount} row(s) with null Employee.email (phone-only sync applied where needed).`,
  );
  if (fixedCount === 0) {
    console.log('No drift found — idempotent no-op run.');
  }
}

main()
  .catch((error) => {
    console.error('backfill-user-contact-sync failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
