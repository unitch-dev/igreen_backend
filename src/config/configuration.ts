export default () => ({
  port: parseInt(process.env.PORT, 10) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  apiPrefix: process.env.API_PREFIX || 'api/v1',
  appUrl: process.env.APP_URL || 'http://localhost:3001',

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'default_secret_change_in_production',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  storage: {
    localDir: process.env.STORAGE_LOCAL_DIR || 'uploads',
  },

  sms: {
    provider: process.env.SMS_PROVIDER || 'smshorizon',
    smsHorizon: {
      apiKey: process.env.SMSHORIZON_API_KEY,
      user: process.env.SMSHORIZON_USER,
      senderId: process.env.SMSHORIZON_SENDER_ID,
      templates: {
        otp: process.env.SMSHORIZON_TID_OTP,
        onboardingWelcome: process.env.SMSHORIZON_TID_ONBOARDING_WELCOME,
        onboardingInvite: process.env.SMSHORIZON_TID_ONBOARDING_INVITE,
        employeeInvite: process.env.SMSHORIZON_TID_EMPLOYEE_INVITE,
        employeeWelcome: process.env.SMSHORIZON_TID_EMPLOYEE_WELCOME,
      },
    },
    fast2smsApiKey: process.env.FAST2SMS_API_KEY, // legacy/rollback only
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },

  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL, 10) || 60,
    limit: parseInt(process.env.THROTTLE_LIMIT, 10) || 100,
  },

  email: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || '"HRMS" <noreply@hrms.in>',
  },
});
