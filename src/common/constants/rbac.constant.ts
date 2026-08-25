// All permission strings used across the HRMS system.
// Import from here in any module that needs to reference permissions.
export const PERMISSIONS = {
  // Employee
  EMPLOYEE_READ: 'employee:read',
  EMPLOYEE_CREATE: 'employee:create',
  EMPLOYEE_UPDATE: 'employee:update',
  EMPLOYEE_DELETE: 'employee:delete',

  // Payroll
  PAYROLL_READ: 'payroll:read',
  PAYROLL_RUN: 'payroll:run',
  PAYROLL_APPROVE: 'payroll:approve',

  // Leave
  LEAVE_READ: 'leave:read',
  LEAVE_APPLY: 'leave:apply',
  LEAVE_APPROVE: 'leave:approve',

  // Loan
  LOAN_READ: 'loan:read',
  LOAN_APPLY: 'loan:apply',
  LOAN_APPROVE: 'loan:approve',

  // Todo / Tasks
  TODO_READ: 'todo:read',
  TODO_CREATE: 'todo:create',
  TODO_APPROVE: 'todo:approve',

  // Attendance
  ATTENDANCE_READ: 'attendance:read',
  ATTENDANCE_CHECKIN: 'attendance:checkin',
  ATTENDANCE_CORRECT: 'attendance:correct',

  // Organization
  ORG_READ: 'org:read',
  ORG_UPDATE: 'org:update',

  // Payroll (extended)
  PAYROLL_CREATE: 'payroll:create',
  PAYROLL_UPDATE: 'payroll:update',
  PAYROLL_DELETE: 'payroll:delete',

  // Roles
  ROLE_READ: 'role:read',
  ROLE_CREATE: 'role:create',
  ROLE_UPDATE: 'role:update',
  ROLE_DELETE: 'role:delete',
  ROLE_ASSIGN: 'role:assign',

  // Assets
  ASSET_READ: 'asset:read',
  ASSET_ASSIGN: 'asset:assign',
  ASSET_RETURN: 'asset:return',

  // Service requests
  SERVICE_REQUEST_READ: 'service_request:read',
  SERVICE_REQUEST_CREATE: 'service_request:create',
  SERVICE_REQUEST_MANAGE: 'service_request:manage',

  // Reports
  REPORT_READ: 'report:read',
  REPORT_EXPORT: 'report:export',
  REPORT_AUDIT: 'report:audit',

  // Onboarding / Exit
  ONBOARDING_MANAGE: 'onboarding:manage',
  EXIT_MANAGE: 'exit:manage',

  // User management
  USER_READ: 'user:read',
  USER_MANAGE: 'user:manage',

  // Profile
  PROFILE_READ: 'profile:read',
  PROFILE_UPDATE: 'profile:update',

  // Performance
  PERFORMANCE_READ: 'performance:read',
  PERFORMANCE_MANAGE: 'performance:manage',

  // Incentives
  INCENTIVE_READ: 'incentive:read',
  INCENTIVE_MANAGE: 'incentive:manage',

  // Insurance
  INSURANCE_READ: 'insurance:read',
  INSURANCE_MANAGE: 'insurance:manage',

  // Disciplinary
  DISCIPLINARY_READ: 'disciplinary:read',
  DISCIPLINARY_MANAGE: 'disciplinary:manage',

  // Notices
  NOTICE_READ: 'notice:read',
  NOTICE_MANAGE: 'notice:manage',

  // Green Thanks
  GREEN_THANKS_READ: 'green_thanks:read',
  GREEN_THANKS_CREATE: 'green_thanks:create',
  GREEN_THANKS_MANAGE: 'green_thanks:manage',
} as const;

export const SYSTEM_ROLES = [
  {
    name: 'super_admin',
    description:
      'Full system access — can manage everything including organizations and system settings',
    permissions: ['*'],
  },
  {
    name: 'org_admin',
    description: 'Organization-level admin — manages users, roles, departments, and all modules',
    permissions: [
      PERMISSIONS.ORG_READ,
      PERMISSIONS.ORG_UPDATE,
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.EMPLOYEE_CREATE,
      PERMISSIONS.EMPLOYEE_UPDATE,
      PERMISSIONS.EMPLOYEE_DELETE,
      PERMISSIONS.PAYROLL_READ,
      PERMISSIONS.PAYROLL_CREATE,
      PERMISSIONS.PAYROLL_UPDATE,
      PERMISSIONS.PAYROLL_DELETE,
      PERMISSIONS.PAYROLL_RUN,
      PERMISSIONS.PAYROLL_APPROVE,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPLY,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.LOAN_READ,
      PERMISSIONS.LOAN_APPLY,
      PERMISSIONS.LOAN_APPROVE,
      PERMISSIONS.TODO_READ,
      PERMISSIONS.TODO_CREATE,
      PERMISSIONS.TODO_APPROVE,
      PERMISSIONS.ATTENDANCE_READ,
      PERMISSIONS.ATTENDANCE_CHECKIN,
      PERMISSIONS.ATTENDANCE_CORRECT,
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.ROLE_CREATE,
      PERMISSIONS.ROLE_UPDATE,
      PERMISSIONS.ROLE_DELETE,
      PERMISSIONS.ROLE_ASSIGN,
      PERMISSIONS.ASSET_READ,
      PERMISSIONS.ASSET_ASSIGN,
      PERMISSIONS.ASSET_RETURN,
      PERMISSIONS.SERVICE_REQUEST_READ,
      PERMISSIONS.SERVICE_REQUEST_CREATE,
      PERMISSIONS.SERVICE_REQUEST_MANAGE,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.REPORT_EXPORT,
      PERMISSIONS.REPORT_AUDIT,
      PERMISSIONS.ONBOARDING_MANAGE,
      PERMISSIONS.EXIT_MANAGE,
      PERMISSIONS.USER_READ,
      PERMISSIONS.USER_MANAGE,
      PERMISSIONS.PROFILE_READ,
      PERMISSIONS.PROFILE_UPDATE,
      PERMISSIONS.PERFORMANCE_READ,
      PERMISSIONS.PERFORMANCE_MANAGE,
      PERMISSIONS.INCENTIVE_READ,
      PERMISSIONS.INCENTIVE_MANAGE,
      PERMISSIONS.INSURANCE_READ,
      PERMISSIONS.INSURANCE_MANAGE,
      PERMISSIONS.DISCIPLINARY_READ,
      PERMISSIONS.DISCIPLINARY_MANAGE,
      PERMISSIONS.NOTICE_READ,
      PERMISSIONS.NOTICE_MANAGE,
      PERMISSIONS.GREEN_THANKS_READ,
      PERMISSIONS.GREEN_THANKS_CREATE,
      PERMISSIONS.GREEN_THANKS_MANAGE,
    ],
  },
  {
    name: 'hr_manager',
    description: 'Manages employee records, leave, onboarding, exit processes, and HR reports',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.EMPLOYEE_CREATE,
      PERMISSIONS.EMPLOYEE_UPDATE,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.ATTENDANCE_READ,
      PERMISSIONS.ATTENDANCE_CORRECT,
      PERMISSIONS.ONBOARDING_MANAGE,
      PERMISSIONS.EXIT_MANAGE,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.REPORT_EXPORT,
      PERMISSIONS.PROFILE_READ,
      PERMISSIONS.PROFILE_UPDATE,
      PERMISSIONS.USER_READ,
      PERMISSIONS.PERFORMANCE_READ,
      PERMISSIONS.PERFORMANCE_MANAGE,
      PERMISSIONS.DISCIPLINARY_READ,
      PERMISSIONS.DISCIPLINARY_MANAGE,
      PERMISSIONS.NOTICE_READ,
      PERMISSIONS.NOTICE_MANAGE,
      PERMISSIONS.GREEN_THANKS_READ,
      PERMISSIONS.GREEN_THANKS_CREATE,
      PERMISSIONS.GREEN_THANKS_MANAGE,
      PERMISSIONS.INSURANCE_READ,
      PERMISSIONS.INSURANCE_MANAGE,
    ],
  },
  {
    name: 'finance_manager',
    description: 'Manages payroll processing, loan approvals, and financial reports',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.PAYROLL_READ,
      PERMISSIONS.PAYROLL_CREATE,
      PERMISSIONS.PAYROLL_UPDATE,
      PERMISSIONS.PAYROLL_DELETE,
      PERMISSIONS.PAYROLL_RUN,
      PERMISSIONS.PAYROLL_APPROVE,
      PERMISSIONS.LOAN_READ,
      PERMISSIONS.LOAN_APPROVE,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.REPORT_EXPORT,
      PERMISSIONS.PROFILE_READ,
      PERMISSIONS.INCENTIVE_READ,
      PERMISSIONS.INCENTIVE_MANAGE,
    ],
  },
  {
    name: 'dept_manager',
    description: 'Department-level manager — approves leave and tasks for their team',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.TODO_READ,
      PERMISSIONS.TODO_APPROVE,
      PERMISSIONS.ATTENDANCE_READ,
      PERMISSIONS.PROFILE_READ,
      PERMISSIONS.PERFORMANCE_READ,
      PERMISSIONS.NOTICE_READ,
      PERMISSIONS.GREEN_THANKS_READ,
      PERMISSIONS.GREEN_THANKS_CREATE,
    ],
  },
  {
    name: 'field_supervisor',
    description: 'Field operations supervisor — tracks attendance and approves field tasks',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.ATTENDANCE_READ,
      PERMISSIONS.TODO_READ,
      PERMISSIONS.TODO_APPROVE,
      PERMISSIONS.PROFILE_READ,
      PERMISSIONS.NOTICE_READ,
      PERMISSIONS.GREEN_THANKS_READ,
      PERMISSIONS.GREEN_THANKS_CREATE,
    ],
  },
  {
    name: 'employee',
    description: 'Standard employee — can apply for leave, check in, and create tasks',
    permissions: [
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPLY,
      PERMISSIONS.TODO_READ,
      PERMISSIONS.TODO_CREATE,
      PERMISSIONS.ATTENDANCE_CHECKIN,
      PERMISSIONS.LOAN_READ,
      PERMISSIONS.LOAN_APPLY,
      PERMISSIONS.PROFILE_READ,
      PERMISSIONS.PROFILE_UPDATE,
      PERMISSIONS.NOTICE_READ,
      PERMISSIONS.GREEN_THANKS_READ,
      PERMISSIONS.GREEN_THANKS_CREATE,
    ],
  },
  {
    name: 'it_admin',
    description: 'IT administrator — manages assets, service requests, and user accounts',
    permissions: [
      PERMISSIONS.ASSET_READ,
      PERMISSIONS.ASSET_ASSIGN,
      PERMISSIONS.ASSET_RETURN,
      PERMISSIONS.SERVICE_REQUEST_READ,
      PERMISSIONS.SERVICE_REQUEST_CREATE,
      PERMISSIONS.SERVICE_REQUEST_MANAGE,
      PERMISSIONS.USER_READ,
      PERMISSIONS.PROFILE_READ,
      PERMISSIONS.REPORT_AUDIT,
    ],
  },
];
