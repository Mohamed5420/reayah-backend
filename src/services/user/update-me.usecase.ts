import { Container, Service } from 'typedi';
import type { Gender } from '../../interfaces/enums';
import type { Language } from '../../utils/i18n';
import { applyPatch } from '../audit/audit.service';
import { UserService } from './user.service';

export type UpdateMeInput = Partial<{
  fullName: string;
  email: string | null;
  gender: Gender;
  dateOfBirth: Date;
  language: Language;
}>;

/**
 * PATCH /me. Only account fields — the "self" patient profile is edited through /patient-profiles (M1.3).
 * Language is also carried in the access token, so a change reaches token-based fallbacks on the next refresh.
 */
@Service()
export class UpdateMeUseCase {
  private readonly users = Container.get(UserService);

  async execute(userId: string, patch: UpdateMeInput) {
    const me = await this.users.getMe(userId);
    if (Object.keys(applyPatch(me.user, patch)).length) await me.user.save();
    return me;
  }
}
