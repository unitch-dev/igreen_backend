/**
 * Canonical mobile-number validation rule, applied to every DTO field that
 * genuinely captures a personal/employee mobile number (not landline/
 * free-text contact fields — see
 * docs/modules/auto-logout-and-mobile-validation.md for the per-field scope
 * decisions). Exactly 10 numeric digits, no country code, no symbols.
 *
 * NOTE: `auth/dto/otp.dto.ts` intentionally uses its own stricter
 * `^[6-9]\d{9}$` (Indian mobile prefix) regex and is NOT migrated to this
 * constant — it already satisfies "10 digits" and should not be loosened.
 */
export const MOBILE_NUMBER_REGEX = /^\d{10}$/;

export const MOBILE_NUMBER_VALIDATION_MESSAGE = 'Mobile number must be exactly 10 digits';
