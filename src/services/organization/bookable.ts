import { VerificationStatus } from '../../interfaces/enums';

/**
 * Organizations a patient may find and book: approved, and not paused for an expired activity licence.
 * Spread it into every patient-facing organization query.
 */
export const bookableOrg = () => ({ verificationStatus: VerificationStatus.APPROVED, licencePausedAt: null });
