import type { IndexOptions, SchemaOptions } from 'mongoose';

/** Options every model schema starts from: `createdAt`/`updatedAt`, no `__v`. */
export const baseSchemaOptions = {
  timestamps: true,
  versionKey: false,
} as const satisfies SchemaOptions;

/** Unique among non-deleted documents only, so a soft-deleted record doesn't block reusing its name. */
export const uniqueAmongActive: IndexOptions = {
  unique: true,
  partialFilterExpression: { deletedAt: { $type: 'null' } },
};

/** Money in piastres: whole, non-negative. */
export const piastresValidator = {
  validator: (v: number | null) => v === null || (Number.isInteger(v) && v >= 0),
  message: 'must be a non-negative integer (piastres)',
};
