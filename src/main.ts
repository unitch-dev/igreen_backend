import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import * as fs from 'fs';
import * as path from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port');
  const apiPrefix = configService.get<string>('apiPrefix');
  const nodeEnv = configService.get<string>('nodeEnv');

  // Serve locally-stored uploads (local disk is the only storage backend)
  app.useStaticAssets(path.join(process.cwd(), configService.get<string>('storage.localDir')), {
    prefix: '/uploads',
  });

  // Security
  app.use(helmet());
  app.use(compression());

  // CORS
  app.enableCors({
    origin: nodeEnv === 'production' ? configService.get('appUrl') : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Global prefix
  app.setGlobalPrefix(apiPrefix);

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

  // Swagger (only in non-production)
  if (nodeEnv !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('IGreen HRMS API')
      .setDescription('Enterprise Human Resource Management System API')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('Auth', 'Authentication & Authorization')
      .addTag('Organizations', 'Organization Management')
      .addTag('Work Locations', 'Geo-Fenced Work Locations for Offline GPS Check-In/OD Resolution')
      .addTag('Zones', 'Lightweight Employee Zone Tags for GlobalLeave Scoping')
      .addTag('Roles & Permissions', 'RBAC — Role & Permission Management')
      .addTag('Employees', 'Employee Management')
      .addTag('Onboarding (HR)', 'Employee Onboarding Link Management (HR-facing)')
      .addTag('Onboarding (Candidate)', 'Employee Onboarding — Public Candidate Flow')
      .addTag('Attendance', 'Attendance & Tracking')
      .addTag('On Duty', 'On-Duty (Field) Attendance Records & Location Tracking')
      .addTag('Leave', 'Leave Management')
      .addTag('Leave Policies', 'Organization Leave Policy Configuration')
      .addTag(
        'Payroll',
        'Payroll Runs & Entries (salary structure/tax config lives under Organizations)',
      )
      .addTag('Loans', 'Loan Management')
      .addTag('Incentives', 'Incentive Rules & Ledger')
      .addTag('Todos', 'Employee Todo/Task Assignment, Submission & Approval (feeds Incentive Ledger)')
      .addTag('Green Thanks', 'Peer-to-Peer Green Thanks Points & Org Configuration')
      .addTag('Notices', 'Company Notice Board — Publishing, Targeting & Read Receipts')
      .addTag(
        'Performance',
        'Performance Review Cycles & Manager Ratings (upward reporting-chain enforced)',
      )
      .addTag(
        'Chat',
        'Internal Messaging — Direct/Group/Department Rooms & REST Message History ' +
          '(real-time delivery is Socket.io on the `/chat` namespace, documented in ChatGateway, not here)',
      )
      .addTag(
        'Service Requests',
        'Employee HR/IT/Admin/Finance Service Requests, Comments & SLA Tracking',
      )
      .addTag('Assets', 'Asset Master, Assignment & Return Lifecycle')
      .addTag(
        'Disciplinary',
        'Disciplinary Memos & Termination-Review Flagging (5+ active memo threshold)',
      )
      .addTag(
        'Exit',
        'Employee Exit Lifecycle — Initiation, Department Clearance & Final Settlement',
      )
      .addTag('Insurance', 'Insurance Policy Master & Employee/Family Enrollment (Approval-Based)')
      .addTag('Dashboards', 'Dashboard Aggregates')
      .addTag(
        'Reports',
        'Org Reports — Headcount, Attendance, Leave, Payroll, Loans, Incentives, ' +
          'Attendance/Live Track, Performance, Todo & Incentive, and Audit History, ' +
          'plus Excel/PDF Export',
      )
      .addTag('Platform Auth', 'Platform-Level Authentication (Super Admin)')
      .addTag('Platform Organizations', 'Platform-Level Organization Management (Super Admin)')
      .addTag('Platform Invoices', 'Platform Billing & Invoices')
      .addTag('Platform Plans', 'Platform Subscription Plans')
      .addTag(
        'Platform RBAC',
        'Platform-Level RBAC Sync — Additively Refreshes Canonical Permissions onto ' +
          "Organizations' System Roles",
      )
      .addTag(
        'SMS Templates',
        'Global/System-Wide SMS Template Management (OTP, Onboarding, Invite, Welcome) — ' +
          'Not Tenant-Scoped',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });

    fs.writeFileSync('./swagger.json', JSON.stringify(document, null, 2));

    console.log(`📖 Swagger docs: http://localhost:${port}/docs`);
  }

  await app.listen(port);
  console.log(`🚀 HRMS API running on: http://localhost:${port}/${apiPrefix}`);
}

bootstrap();
