import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '@common/decorators/public.decorator';
import { PlatformJwtAuthGuard } from '../platform-auth/platform-jwt-auth.guard';
import { RbacService } from './rbac.service';

@Public()
@ApiTags('Platform RBAC')
@ApiBearerAuth()
@UseGuards(PlatformJwtAuthGuard)
@Controller('platform/rbac')
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  @Post('refresh')
  @ApiOperation({
    summary:
      "Sync canonical module permissions onto all organizations' system roles (additive — never removes existing permissions)",
    description:
      'Iterates every organization and, for each of the 8 canonical system roles ' +
      '(super_admin, org_admin, hr_manager, finance_manager, dept_manager, ' +
      'field_supervisor, employee, it_admin), adds any canonical permission the role ' +
      'is missing. Never removes a permission a role already has, and never touches ' +
      'custom (non-system) roles. Requires a valid platform (super admin) session token.',
  })
  @ApiResponse({
    status: 201,
    description: 'RBAC sync completed. Returns a summary of roles created/updated/unchanged.',
    schema: {
      example: {
        success: true,
        data: {
          organizationsProcessed: 12,
          rolesCreated: 3,
          rolesUpdated: 40,
          rolesUnchanged: 53,
          permissionsAdded: 187,
          details: [
            {
              organizationId: 'clx1a2b3c4d5e6f7g8h9',
              organizationName: 'Acme Corp',
              roleName: 'hr_manager',
              action: 'updated',
              addedPermissions: ['leave:approve', 'onboarding:manage'],
            },
          ],
        },
        timestamp: '2026-08-25T10:30:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Not authenticated — missing or invalid platform session token',
    schema: {
      example: {
        statusCode: 401,
        timestamp: '2026-08-25T10:30:00.000Z',
        path: '/api/v1/platform/rbac/refresh',
        method: 'POST',
        message: 'Unauthorized',
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not authorized for platform-level access',
    schema: {
      example: {
        statusCode: 403,
        timestamp: '2026-08-25T10:30:00.000Z',
        path: '/api/v1/platform/rbac/refresh',
        method: 'POST',
        message: 'Forbidden',
      },
    },
  })
  refresh() {
    return this.rbacService.refresh();
  }
}
