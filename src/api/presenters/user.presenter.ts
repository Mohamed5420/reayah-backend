import type { IUser } from '../../interfaces/IUser';
import type { IProviderProfile } from '../../interfaces/IProfiles';

/** Maps users to the API shapes in auth.validation.ts. */

/** The short user object in login / register responses (spec §7.1). */
export const presentAuthUser = (user: IUser) => ({
  id: String(user._id),
  full_name: user.fullName,
  role: user.role,
  language: user.language,
});

/** GET /me (spec §7.2). */
export const presentMe = ({
  user,
  providerProfile,
  avatarUrl,
  unreadNotifications,
}: {
  user: IUser;
  providerProfile: IProviderProfile | null;
  avatarUrl: string | null;
  unreadNotifications: number;
}) => ({
  id: String(user._id),
  phone: user.phone,
  full_name: user.fullName,
  email: user.email,
  gender: user.gender,
  date_of_birth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null,
  role: user.role,
  language: user.language,
  avatar_url: avatarUrl, // signed, 10 minutes
  status: user.status,
  provider_profile: providerProfile
    ? {
        id: String(providerProfile._id),
        type: providerProfile.type,
        verification_status: providerProfile.verificationStatus,
        is_accepting_bookings: providerProfile.isAcceptingBookings,
      }
    : null,
  organization: null, // organizations: Phase 3
  unread_notifications: unreadNotifications,
});
