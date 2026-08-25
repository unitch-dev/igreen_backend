import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { RolesModule } from './modules/roles/roles.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { FilesModule } from './modules/files/files.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/roles.guard';
import { TenantMiddleware } from './common/middleware/tenant.middleware';
import { PlatformAuthModule } from './modules/platform-auth/platform-auth.module';
import { SubscriptionPlansModule } from './modules/subscription-plans/subscription-plans.module';
import { PlatformOrganizationsModule } from './modules/platform-organizations/platform-organizations.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { LeaveModule } from './modules/leave/leave.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { LoansModule } from './modules/loans/loans.module';
import { IncentivesModule } from './modules/incentives/incentives.module';
import { GreenThanksModule } from './modules/green-thanks/green-thanks.module';
import { NoticesModule } from './modules/notices/notices.module';
import { ChatModule } from './modules/chat/chat.module';
import { PerformanceModule } from './modules/performance/performance.module';
import { ServiceRequestsModule } from './modules/service-requests/service-requests.module';
import { AssetsModule } from './modules/assets/assets.module';
import { DisciplinaryModule } from './modules/disciplinary/disciplinary.module';
import { ExitModule } from './modules/exit/exit.module';
import { InsuranceModule } from './modules/insurance/insurance.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RbacModule } from './modules/rbac/rbac.module';

@Module({
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  imports: [
    // CLS (Continuation-Local Storage) — provides per-request async context for audit fields
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),

    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('throttle.ttl') * 1000,
          limit: config.get<number>('throttle.limit'),
        },
      ],
    }),

    // Cron scheduler
    ScheduleModule.forRoot(),

    // BullMQ (background jobs)
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
          password: config.get<string>('redis.password'),
        },
      }),
    }),

    // Core infrastructure modules
    PrismaModule,
    RedisModule,

    // Feature modules
    AuthModule,
    RolesModule,

    // Feature modules (M05+)
    OrganizationsModule,
    NotificationsModule,
    FilesModule,
    EmployeesModule,
    PlatformAuthModule,
    SubscriptionPlansModule,
    PlatformOrganizationsModule,
    InvoicesModule,
    DashboardModule,
    AttendanceModule,
    LeaveModule,
    PayrollModule,
    LoansModule,
    IncentivesModule,
    GreenThanksModule,
    NoticesModule,
    ChatModule,
    PerformanceModule,
    ServiceRequestsModule,
    AssetsModule,
    DisciplinaryModule,
    ExitModule,
    InsuranceModule,
    ReportsModule,
    RbacModule,
    // Modules to be added as they are developed
    // RemindersModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
