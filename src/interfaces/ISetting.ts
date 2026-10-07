import type { Types } from 'mongoose';

/** One admin-overridden setting. Keys and defaults are defined in services/settings/settings.definitions.ts. */
export interface ISetting {
  _id: Types.ObjectId;
  key: string;
  value: unknown;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}
