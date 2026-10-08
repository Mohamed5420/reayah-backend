import mongoose from 'mongoose';
import { Container, Service } from 'typedi';
import { UserModel } from '../../database/models/user/user.model';
import { PatientProfileModel } from '../../database/models/patient/patient-profile.model';
import { ProviderProfileModel } from '../../database/models/provider/provider-profile.model';
import { Relation, UserRole, type Gender } from '../../interfaces/enums';
import type { IUser } from '../../interfaces/IUser';
import type { Language } from '../../utils/i18n';
import { ConflictError } from '../../utils/types-errors';
import { TokenService } from './token.service';
import { verifyRegistrationToken } from './jwt';
import { ReferralService } from '../marketing/referral.service';
import { StaffService } from '../organization/staff.service';

export type RegisterInput = {
  role: UserRole.PATIENT | UserRole.PROVIDER | UserRole.OWNER | UserRole.PROVIDER_STAFF;
  fullName: string;
  gender: Gender;
  dateOfBirth: Date;
  email?: string | null;
  language?: Language;
  referralCode?: string | null;
  /** Required for provider_staff: the organization's invite to this number. */
  staffInviteId?: string;
};

/**
 * POST /auth/register (spec §7.1). The user and their role's profile are created in one transaction:
 * patient → "self" patient profile; provider → draft provider profile; owner → nothing yet (POST /org);
 * provider_staff (with an organization's invite to this number) → draft profile linked to the organization.
 */
@Service()
export class RegisterUseCase {
  private readonly tokens = Container.get(TokenService);

  async execute(registrationToken: string, input: RegisterInput) {
    const phone = verifyRegistrationToken(registrationToken);

    let user!: mongoose.HydratedDocument<IUser>;
    let invite: { organizationId: mongoose.Types.ObjectId } | null = null;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (await UserModel.exists({ phone }).session(session)) {
          throw new ConflictError('errors.phone_taken');
        }
        [user] = await UserModel.create(
          [
            {
              phone,
              role: input.role,
              fullName: input.fullName,
              gender: input.gender,
              dateOfBirth: input.dateOfBirth,
              email: input.email ?? null,
              language: input.language ?? 'ar',
              referredByCode: input.referralCode?.trim().toUpperCase() || null,
              lastLoginAt: new Date(),
            },
          ],
          { session },
        );

        await Container.get(ReferralService).recordAtSignup(session, user, input.referralCode);

        if (input.role === UserRole.PATIENT) {
          await PatientProfileModel.create(
            [
              {
                ownerUserId: user._id,
                fullName: input.fullName,
                relation: Relation.SELF,
                gender: input.gender,
                dateOfBirth: input.dateOfBirth,
              },
            ],
            { session },
          );
        } else if (input.role === UserRole.PROVIDER) {
          await ProviderProfileModel.create([{ userId: user._id }], { session });
        } else if (input.role === UserRole.PROVIDER_STAFF) {
          invite = await Container.get(StaffService).joinAtSignup(session, user, input.staffInviteId ?? '');
        }
      });
    } finally {
      await session.endSession();
    }

    if (invite) await Container.get(StaffService).notifyOwner(invite, user.fullName);
    return { user, tokens: await this.tokens.startSession(user) };
  }
}
