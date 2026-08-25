import { PrismaClient } from '@prisma/client';
import { refreshRbacPolicies } from '../common/rbac/rbac-refresh';

const prisma = new PrismaClient();

async function main() {
  console.log('Refreshing RBAC policies across all organizations...');

  const summary = await refreshRbacPolicies(prisma);

  console.log('\nRBAC refresh complete.');
  console.log(`Organizations processed: ${summary.organizationsProcessed}`);
  console.log(`Roles created:           ${summary.rolesCreated}`);
  console.log(`Roles updated:           ${summary.rolesUpdated}`);
  console.log(`Roles unchanged:         ${summary.rolesUnchanged}`);
  console.log(`Permissions added:       ${summary.permissionsAdded}`);

  const changed = summary.details.filter((d) => d.action !== 'unchanged');
  if (changed.length > 0) {
    console.log('\nDetails (created/updated only):');
    for (const detail of changed) {
      console.log(
        `  [${detail.action.toUpperCase()}] org="${detail.organizationName}" (${detail.organizationId}) role="${detail.roleName}"` +
          (detail.addedPermissions.length > 0
            ? ` addedPermissions=${JSON.stringify(detail.addedPermissions)}`
            : ''),
      );
    }
  } else {
    console.log('\nNo roles required changes — all organizations already up to date.');
  }
}

main()
  .catch((e) => {
    console.error('RBAC refresh failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
