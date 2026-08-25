import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '@common/constants/rbac.constant';

export interface RbacRefreshDetail {
  organizationId: string;
  organizationName: string;
  roleName: string;
  action: 'created' | 'updated' | 'unchanged';
  addedPermissions: string[];
}

export interface RbacRefreshSummary {
  organizationsProcessed: number;
  rolesCreated: number;
  rolesUpdated: number;
  rolesUnchanged: number;
  permissionsAdded: number;
  details: RbacRefreshDetail[];
}

/**
 * Additively syncs the canonical `SYSTEM_ROLES` permission set (see
 * `@common/constants/rbac.constant`) onto every organization's system roles.
 *
 * Never removes a permission a role already has. If the canonical permission
 * list for a role is `['*']` (super_admin), the target becomes `['*']`
 * unless it already is. If an existing role already contains `'*'`, it is
 * treated as a superset of any canonical list and left untouched. Only rows
 * with `isSystemRole: true` matching one of the 8 canonical role names are
 * ever touched — custom, org-created roles are never modified.
 *
 * Accepts a plain `PrismaClient` so both the standalone CLI script (which
 * instantiates its own `PrismaClient`) and the NestJS `RbacService` (which
 * injects `PrismaService`, a `PrismaClient` subclass) can share this logic.
 */
export async function refreshRbacPolicies(prisma: PrismaClient): Promise<RbacRefreshSummary> {
  const organizations = await prisma.organization.findMany({
    select: { id: true, name: true },
  });

  const summary: RbacRefreshSummary = {
    organizationsProcessed: organizations.length,
    rolesCreated: 0,
    rolesUpdated: 0,
    rolesUnchanged: 0,
    permissionsAdded: 0,
    details: [],
  };

  for (const org of organizations) {
    for (const canonical of SYSTEM_ROLES) {
      const existing = await prisma.role.findFirst({
        where: { organizationId: org.id, name: canonical.name },
      });

      if (!existing) {
        await prisma.role.create({
          data: {
            organizationId: org.id,
            name: canonical.name,
            description: canonical.description,
            permissions: canonical.permissions,
            isSystemRole: true,
          },
        });
        summary.rolesCreated += 1;
        summary.permissionsAdded += canonical.permissions.length;
        summary.details.push({
          organizationId: org.id,
          organizationName: org.name,
          roleName: canonical.name,
          action: 'created',
          addedPermissions: [...canonical.permissions],
        });
        continue;
      }

      const existingPermissions = (existing.permissions as string[]) ?? [];
      const isWildcardCanonical =
        canonical.permissions.length === 1 && canonical.permissions[0] === '*';
      const alreadyWildcard = existingPermissions.includes('*');

      if (alreadyWildcard) {
        summary.rolesUnchanged += 1;
        summary.details.push({
          organizationId: org.id,
          organizationName: org.name,
          roleName: canonical.name,
          action: 'unchanged',
          addedPermissions: [],
        });
        continue;
      }

      if (isWildcardCanonical) {
        await prisma.role.update({
          where: { id: existing.id },
          data: { permissions: ['*'] },
        });
        summary.rolesUpdated += 1;
        summary.permissionsAdded += 1;
        summary.details.push({
          organizationId: org.id,
          organizationName: org.name,
          roleName: canonical.name,
          action: 'updated',
          addedPermissions: ['*'],
        });
        continue;
      }

      const merged = Array.from(new Set([...existingPermissions, ...canonical.permissions]));

      if (merged.length === existingPermissions.length) {
        summary.rolesUnchanged += 1;
        summary.details.push({
          organizationId: org.id,
          organizationName: org.name,
          roleName: canonical.name,
          action: 'unchanged',
          addedPermissions: [],
        });
        continue;
      }

      const addedPermissions = merged.filter((p) => !existingPermissions.includes(p));

      await prisma.role.update({
        where: { id: existing.id },
        data: { permissions: merged },
      });
      summary.rolesUpdated += 1;
      summary.permissionsAdded += addedPermissions.length;
      summary.details.push({
        organizationId: org.id,
        organizationName: org.name,
        roleName: canonical.name,
        action: 'updated',
        addedPermissions,
      });
    }
  }

  return summary;
}
