import { SubscriptionPlanModel } from '../models/organization/organization.models';
import { SEED_PLANS } from './data/plans.data';

/** Plans for organizations: inserted once, never overwritten (admins edit them). */
export const seedPlans = async () => {
  await SubscriptionPlanModel.bulkWrite(
    SEED_PLANS.map((plan) => ({
      updateOne: {
        filter: { key: plan.key },
        update: { $setOnInsert: plan },
        upsert: true,
      },
    })),
  );
};
