import type { Aggregate, MongooseQueryMiddleware, Query, Schema } from 'mongoose';

/** Add to the model's document interface. */
export interface SoftDeleteFields {
  deletedAt: Date | null;
}

/** Pass as the methods type: `model<IThing, Model<IThing, {}, SoftDeleteMethods>>(...)`. */
export interface SoftDeleteMethods {
  softDelete(): Promise<this>;
  restore(): Promise<this>;
}

/** Query operations that skip soft-deleted documents. Hard deletes are left alone on purpose. */
const FILTERED_QUERIES: MongooseQueryMiddleware[] = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'countDocuments',
  'distinct',
  'updateOne',
  'updateMany',
  'replaceOne',
];

/**
 * Adds `deletedAt` (spec §4: soft delete on every table) and hides deleted documents from queries.
 *
 * - Delete: `await doc.softDelete()` or `Model.updateOne(filter, { deletedAt: new Date() })`.
 * - Include deleted docs: `.setOptions({ withDeleted: true })`, or filter on `deletedAt` explicitly.
 * - Aggregations get a leading `$match`; pass `{ withDeleted: true }` in aggregate options to skip it.
 * - `estimatedDocumentCount()` cannot be filtered — use `countDocuments()`.
 * - Unique indexes still see deleted docs; use a partial index (`deletedAt: null`) where that matters.
 */
export const softDeletePlugin = (schema: Schema) => {
  schema.add({ deletedAt: { type: Date, default: null, index: true } });

  schema.pre<Query<unknown, unknown>>(FILTERED_QUERIES, function () {
    if (this.getOptions().withDeleted) return;
    if (this.getFilter().deletedAt !== undefined) return;
    this.where({ deletedAt: null });
  });

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    if ((this.options as { withDeleted?: boolean }).withDeleted) return;
    const first = this.pipeline()[0] as { $match?: { deletedAt?: unknown } } | undefined;
    if (first?.$match?.deletedAt !== undefined) return;
    this.pipeline().unshift({ $match: { deletedAt: null } });
  });

  schema.method('softDelete', function () {
    this.set('deletedAt', new Date());
    return this.save();
  });

  schema.method('restore', function () {
    this.set('deletedAt', null);
    return this.save();
  });
};
