import { Injectable } from '@nestjs/common';
import { PrismaService } from '@prisma/prisma.service';
import { refreshRbacPolicies, RbacRefreshSummary } from '@common/rbac/rbac-refresh';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  async refresh(): Promise<RbacRefreshSummary> {
    return refreshRbacPolicies(this.prisma);
  }
}
