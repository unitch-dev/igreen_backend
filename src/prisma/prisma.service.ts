import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';

// Models that track who created a record
const MODELS_WITH_CREATED_BY = new Set([
  'Organization',
  'Role',
  'Department',
  'Designation',
  'PayrollStructure',
  'Employee',
  'LeavePolicy',
  'LeaveApplication',
  'TaxRule',
  'Holiday',
  'AttendanceLog',
  'PayrollRun',
  'PayrollEntry',
  'LoanApplication',
  'IncentiveRule',
  'TodoTask',
  'IncentiveLedger',
  'GreenThanks',
  'GreenThanksConfig',
  'ChatRoom',
  'OnboardingLink',
  'ServiceRequest',
  'ServiceRequestComment',
  'Asset',
  'AssetAssignment',
  'DisciplinaryMemo',
  'ExitRecord',
  'InsurancePolicy',
  'EmployeeInsurance',
  'Reminder',
  'PerformanceCycle',
  'Notice',
]);

// Subset of above that also track who last updated a record
const MODELS_WITH_UPDATED_BY = new Set([
  'Organization',
  'Role',
  'Department',
  'Designation',
  'PayrollStructure',
  'Employee',
  'LeavePolicy',
  'AttendanceLog',
  'PayrollRun',
  'PayrollEntry',
  'LoanApplication',
  'IncentiveRule',
  'TodoTask',
  'Notice',
  'ServiceRequest',
  'Asset',
]);

// Models whose writes are audited into AuditLog: the union of the two sets above.
// This IS the whitelist — do not maintain a separate list. `AuditLog` itself must
// NEVER be added to either set above, or this middleware would recursively audit
// its own audit-log writes.
const AUDITED_MODELS = new Set([...MODELS_WITH_CREATED_BY, ...MODELS_WITH_UPDATED_BY]);

// Maps a Prisma middleware action to the AuditLog.action string we persist.
// NOTE: `upsert` is tagged 'UPSERT' rather than being resolved to CREATE/UPDATE —
// cheaply distinguishing which branch actually ran would require an extra read
// before `next(params)`, which isn't worth it for a best-effort audit trail.
function mapAuditAction(action: string): string | null {
  switch (action) {
    case 'create':
      return 'CREATE';
    case 'update':
    case 'updateMany':
      return 'UPDATE';
    case 'delete':
    case 'deleteMany':
      return 'DELETE';
    case 'upsert':
      return 'UPSERT';
    default:
      return null;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly cls: ClsService) {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'error' },
        { emit: 'stdout', level: 'warn' },
      ],
    });

    // Auto-inject createdById / updatedById from the active CLS context on every write
    (this as any).$use(async (params: any, next: any) => {
      const userId = this.cls?.get?.('userId') as string | undefined;

      if (userId && params.model) {
        if (params.action === 'create' && MODELS_WITH_CREATED_BY.has(params.model)) {
          params.args.data = { ...params.args.data, createdById: userId };
        }

        if (
          (params.action === 'update' || params.action === 'updateMany') &&
          MODELS_WITH_UPDATED_BY.has(params.model)
        ) {
          params.args.data = { ...params.args.data, updatedById: userId };
        }

        if (params.action === 'upsert') {
          if (MODELS_WITH_CREATED_BY.has(params.model) && params.args.create) {
            params.args.create = { ...params.args.create, createdById: userId };
          }
          if (MODELS_WITH_UPDATED_BY.has(params.model) && params.args.update) {
            params.args.update = { ...params.args.update, updatedById: userId };
          }
        }
      }

      const result = await next(params);

      // Best-effort AuditLog write. Never let this throw back into the caller —
      // the original business write (`result`) must always succeed/return unchanged
      // regardless of what happens here.
      if (userId && params.model && AUDITED_MODELS.has(params.model)) {
        const auditAction = mapAuditAction(params.action);

        // `updateMany`/`deleteMany` have no single affected row id — skip auditing
        // them entirely rather than logging an entry with a null entityId for an
        // unknown number of affected rows.
        const isBulkAction = params.action === 'updateMany' || params.action === 'deleteMany';

        if (auditAction && !isBulkAction) {
          const entityId = (result as { id?: string } | null)?.id ?? null;
          const organizationId =
            (result as { organizationId?: string } | null)?.organizationId ??
            params.args?.data?.organizationId ??
            null;

          (this as any).auditLog
            .create({
              data: {
                action: auditAction,
                entityType: params.model,
                entityId,
                actorId: userId,
                organizationId,
                // oldValue/newValue deliberately left null this pass: capturing full
                // row snapshots risks persisting PII (bank/health/salary fields, etc.)
                // into a report-surfaced table with no redaction policy yet.
                // ipAddress/userAgent deliberately left null: no CLS-accessible
                // request-context value exists at this layer today (LoginHistory
                // captures these directly from the controller/service call chain,
                // not via CLS) — wiring a new CLS key end-to-end is out of scope.
              },
            })
            .catch((err: unknown) => {
              this.logger.warn(
                `Failed to write AuditLog for ${params.model}.${params.action}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        }
      }

      return result;
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected successfully');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  async cleanDatabase() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('cleanDatabase() is not allowed in production');
    }
    const tableNames = await this.$queryRaw<{ TABLE_NAME: string }[]>`
      SELECT TABLE_NAME FROM information_schema.tables
      WHERE table_schema = DATABASE()
      AND TABLE_NAME != '_prisma_migrations'
    `;
    for (const { TABLE_NAME } of tableNames) {
      await this.$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
    }
  }
}
