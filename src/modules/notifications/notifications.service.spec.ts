import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '@prisma/prisma.service';

// The service dynamically `import('axios')`s only inside the production
// branch of sendSms/checkSmsStatus — mock the module so those branches never
// make a real network call.
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockedAxios = require('axios').default as { post: jest.Mock };

// nodemailer.createTransport is called in the constructor — stub it so the
// spec doesn't try to open a real SMTP connection.
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
}));

describe('NotificationsService.sendSms', () => {
  let service: NotificationsService;
  let prisma: { smsTemplate: { findUnique: jest.Mock } };
  let config: { get: jest.Mock };
  let nodeEnv: string;

  const CONFIG_VALUES: Record<string, unknown> = {
    'email.host': 'smtp.test',
    'email.port': 587,
    'email.user': 'user',
    'email.pass': 'pass',
    'email.from': 'noreply@test.com',
    'sms.smsHorizon.user': 'sms-user',
    'sms.smsHorizon.apiKey': 'sms-api-key',
    'sms.smsHorizon.senderId': 'DEFSND',
  };

  beforeEach(() => {
    nodeEnv = 'development';
    prisma = { smsTemplate: { findUnique: jest.fn() } };
    config = {
      get: jest.fn((key: string) => (key === 'nodeEnv' ? nodeEnv : CONFIG_VALUES[key])),
    };
    mockedAxios.post.mockReset();

    service = new NotificationsService(
      config as unknown as ConfigService,
      prisma as unknown as PrismaService,
    );
    // Silence + allow assertions on logger output without real console noise.
    (
      service as unknown as { logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock } }
    ).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
  });

  function getLogger() {
    return (service as unknown as { logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock } })
      .logger;
  }

  describe('placeholder substitution', () => {
    it('substitutes a single placeholder for the otp template', async () => {
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'otp',
        message: 'Your IGreen HRMS login OTP is: {{otp}}. Valid for 5 minutes.',
        isActive: true,
        tid: null,
        senderId: null,
      });

      await service.sendSms('9999999999', 'otp', { otp: '482913' });

      expect(getLogger().log).toHaveBeenCalledWith(
        expect.stringContaining('Your IGreen HRMS login OTP is: 482913. Valid for 5 minutes.'),
      );
    });

    it('substitutes every placeholder in a multi-variable template', async () => {
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'onboardingWelcome',
        message:
          'Welcome! Your Employee ID: {{empCode}}. Login: {{email}}, Temp Password: {{tempPassword}}. Change password on first login.',
        isActive: true,
        tid: null,
        senderId: null,
      });

      await service.sendSms('9999999999', 'onboardingWelcome', {
        empCode: 'EMP-042',
        email: 'jane@acme.test',
        tempPassword: 'Tmp@1234',
      });

      expect(getLogger().log).toHaveBeenCalledWith(
        expect.stringContaining(
          'Welcome! Your Employee ID: EMP-042. Login: jane@acme.test, Temp Password: Tmp@1234. Change password on first login.',
        ),
      );
    });

    it('leaves an unmatched placeholder token intact and warns instead of throwing', async () => {
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'onboardingInvite',
        message: "You've been invited to join the team. Complete your onboarding at: {{link}}",
        isActive: true,
        tid: null,
        senderId: null,
      });

      await service.sendSms('9999999999', 'onboardingInvite', {});

      expect(getLogger().warn).toHaveBeenCalledWith(expect.stringContaining('{{link}}'));
      expect(getLogger().log).toHaveBeenCalledWith(expect.stringContaining('{{link}}'));
    });
  });

  describe('missing/inactive template guard', () => {
    it('throws when the template key does not exist', async () => {
      prisma.smsTemplate.findUnique.mockResolvedValue(null);

      await expect(service.sendSms('9999999999', 'otp', { otp: '123456' })).rejects.toThrow(
        "SMS template 'otp' not found or inactive",
      );
    });

    it('throws when the template exists but isActive is false', async () => {
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'otp',
        message: 'Your OTP is {{otp}}',
        isActive: false,
        tid: null,
        senderId: null,
      });

      await expect(service.sendSms('9999999999', 'otp', { otp: '123456' })).rejects.toThrow(
        "SMS template 'otp' not found or inactive",
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('dev-mode short-circuit', () => {
    it('logs the RENDERED message with a [DEV SMS] prefix and never hits the network', async () => {
      nodeEnv = 'development';
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'otp',
        message: 'Your OTP is {{otp}}',
        isActive: true,
        tid: null, // no tid configured yet — must NOT throw in dev
        senderId: null,
      });

      const result = await service.sendSms('9999999999', 'otp', { otp: '654321' });

      expect(result).toBeUndefined();
      expect(getLogger().log).toHaveBeenCalledWith(expect.stringContaining('[DEV SMS]'));
      expect(getLogger().log).toHaveBeenCalledWith(expect.stringContaining('Your OTP is 654321'));
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('production path', () => {
    it('throws a clear error when tid is null', async () => {
      nodeEnv = 'production';
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'otp',
        message: 'Your OTP is {{otp}}',
        isActive: true,
        tid: null,
        senderId: null,
      });

      await expect(service.sendSms('9999999999', 'otp', { otp: '654321' })).rejects.toThrow(
        "SMS template 'otp' has no DLT template id (tid) configured",
      );
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('sends via SMSHorizon with the rendered message, template tid, and template senderId override', async () => {
      nodeEnv = 'production';
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'otp',
        message: 'Your OTP is {{otp}}',
        isActive: true,
        tid: '1000000000000000001',
        senderId: 'CUSTOM',
      });
      mockedAxios.post.mockResolvedValue({ data: { msgid: 'msg-123' } });

      const result = await service.sendSms('9999999999', 'otp', { otp: '654321' });

      expect(result).toEqual({ msgid: 'msg-123' });
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, body] = mockedAxios.post.mock.calls[0];
      expect(url).toBe('https://smshorizon.co.in/api/v2/sendsms.php');
      expect(body).toContain('message=Your+OTP+is+654321');
      expect(body).toContain('senderid=CUSTOM');
      expect(body).toContain('tid=1000000000000000001');
    });

    it('falls back to the config default senderId when the template has none', async () => {
      nodeEnv = 'production';
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'otp',
        message: 'Your OTP is {{otp}}',
        isActive: true,
        tid: '1000000000000000001',
        senderId: null,
      });
      mockedAxios.post.mockResolvedValue({ data: { msgid: 'msg-456' } });

      await service.sendSms('9999999999', 'otp', { otp: '111111' });

      const [, body] = mockedAxios.post.mock.calls[0];
      expect(body).toContain('senderid=DEFSND');
    });

    it('throws a distinct error when SMSHorizon returns a provider-level error', async () => {
      nodeEnv = 'production';
      prisma.smsTemplate.findUnique.mockResolvedValue({
        key: 'otp',
        message: 'Your OTP is {{otp}}',
        isActive: true,
        tid: '1000000000000000001',
        senderId: null,
      });
      mockedAxios.post.mockResolvedValue({ data: { error: 'DLT template mismatch' } });

      await expect(service.sendSms('9999999999', 'otp', { otp: '111111' })).rejects.toThrow(
        'SMSHorizon error: DLT template mismatch',
      );
    });
  });
});
