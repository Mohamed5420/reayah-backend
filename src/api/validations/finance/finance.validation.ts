import { LedgerEntryType, LedgerOwnerType } from '../../../interfaces/ILedger';
import { PayoutMethodType, PayoutStatus, WALLET_PROVIDERS } from '../../../interfaces/IPayout';
import { REPORT_TYPES } from '../../../services/reports/report.service';
import { objectId, paginationQuery, z } from '../zod';

const date = z.iso.date().openapi({ example: '2026-10-01', description: 'Cairo calendar date' });

const payoutMethod = z
  .object({
    type: z.enum(PayoutMethodType),
    account_holder: z.string(),
    bank_name: z.string().nullable(),
    wallet_provider: z.enum(WALLET_PROVIDERS).nullable(),
    /** Last 4 digits only. */
    account_number_last4: z.string(),
    label: z.string(),
  })
  .nullable()
  .openapi('PayoutMethod');

const payout = z
  .object({
    id: objectId,
    amount: z.number(),
    status: z.enum(PayoutStatus),
    destination: z.string().openapi({ description: 'Masked, e.g. "بنك مصر •••• 4821"' }),
    /**
     * card_earnings − commission_deducted + commission_paid + discounts_reimbursed + referral_rewards
     * − other_deductions + adjustments = net.
     */
    statement: z.object({
      card_earnings: z.number(),
      commission_deducted: z
        .number()
        .openapi({ description: 'Commission on cash bookings, taken from this payout' }),
      commission_paid: z.number().openapi({ description: 'Commission you paid from the app in this period' }),
      discounts_reimbursed: z.number().openapi({
        description: 'Promo / package / credit discounts on cash visits — the platform bears them',
      }),
      referral_rewards: z.number(),
      /** Organizations: plan fees net of credits, taken from this payout. */
      subscription_fees: z.number(),
      other_deductions: z.number().openapi({ description: 'e.g. dispute refunds you bore' }),
      adjustments: z.number(),
      net: z.number(),
    }),
    batch_date: z.string(),
    reference: z.string().nullable(),
    paid_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('Payout');

/** Request and response schemas for earnings, payouts and admin finance (spec §7.10, §7.15). */
export const FinanceSchemas = {
  idParams: z.object({ id: objectId }),
  /** Cairo dates; default this month so far. At most 366 days. */
  earningsQuery: z.object({ from: date.optional(), to: date.optional() }),
  earnings: z
    .object({
      period: z.object({ from: z.string(), to: z.string() }),
      completed_visits: z.number(),
      gross: z.number(),
      commission: z.number(),
      net: z.number(),
      /** The platform owes the provider (card / wallet bookings), net of commission due. */
      wallet_balance: z.number(),
      /** The provider owes the platform (cash commission), net of card earnings. */
      commission_due: z.number(),
      currency: z.literal('EGP'),
      payout_method: payoutMethod,
      /** Cash-booking commission limit: warning from commission_warning_percent, over_limit = no new cash bookings. */
      commission_limit: z.object({ max: z.number(), warning: z.boolean(), over_limit: z.boolean() }),
      /** Cash the provider took from patients for visits completed in the period (piastres). */
      cash_collected: z.number(),
      /** One row per Cairo day of the period, days without visits included (0). */
      days: z.array(z.object({ date: z.string(), completed_visits: z.number(), net: z.number() })),
      /** The next weekly payout and whether the current balance will be paid in it. */
      next_payout: z.object({
        /** Cairo date of the next payout batch ("YYYY-MM-DD"). */
        date: z.string(),
        /** What would be paid: the current balance (0 when the provider owes commission). */
        amount: z.number(),
        /** Smallest balance paid out (setting payout_min_amount). */
        minimum_amount: z.number(),
        eligible: z.boolean(),
        /** Why not: below_minimum, no_payout_method, payout_in_progress, commission_due; null when eligible. */
        reason: z
          .enum(['below_minimum', 'no_payout_method', 'payout_in_progress', 'commission_due'])
          .nullable(),
      }),
    })
    .openapi('ProviderEarnings'),
  ledgerEntry: z
    .object({
      id: objectId,
      type: z.enum(LedgerEntryType),
      amount: z
        .number()
        .openapi({ description: 'Signed piastres: + platform owes you, − you owe the platform' }),
      balance_after: z.number(),
      booking_id: objectId.nullable(),
      note: z.string().nullable(),
      created_at: z.string(),
    })
    .openapi('LedgerEntry'),
  payout,
  payoutMethod,
  payoutMethodBody: z
    .strictObject({
      type: z.enum(PayoutMethodType),
      account_holder: z.string().trim().min(3).max(100),
      /** Bank only. */
      bank_name: z.string().trim().min(2).max(100).nullable().optional(),
      /** Wallet only. */
      wallet_provider: z.enum(WALLET_PROVIDERS).nullable().optional(),
      /** IBAN / account number, or the wallet's mobile number. */
      account_number: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9+ ]{6,34}$/, { error: 'validation.account_number' }),
    })
    .openapi('PayoutMethodRequest'),
  pageQuery: paginationQuery,

  // ── Admin ──
  adminPayoutsQuery: paginationQuery.extend({ status: z.enum(PayoutStatus).optional() }),
  adminPayout: z
    .object({
      ...payout.shape,
      owner_type: z.enum(LedgerOwnerType),
      /** Set for a provider's payout. */
      provider: z.object({ id: objectId, name: z.string(), phone: z.string() }).nullable(),
      /** Set for an organization's payout. */
      organization: z.object({ id: objectId, name: z.string(), phone: z.string() }).nullable(),
      /** Full details, to make the transfer. */
      destination_details: z.record(z.string(), z.string().nullable()),
    })
    .openapi('AdminPayout'),
  generated: z.object({ created: z.number(), total: z.number() }),
  bulkApproveBody: z.strictObject({ payout_ids: z.array(objectId).min(1).max(500) }),
  bulkApproved: z.object({ approved: z.array(objectId), skipped: z.array(z.string()) }),
  markPaidBody: z.strictObject({ reference: z.string().trim().min(2).max(100) }),
  cancelBody: z.strictObject({ reason: z.string().trim().min(3).max(500) }),
  commissionDue: z
    .object({
      owner_type: z.enum(LedgerOwnerType),
      provider: z.object({ id: objectId, name: z.string(), phone: z.string() }).nullable(),
      organization: z.object({ id: objectId, name: z.string(), phone: z.string() }).nullable(),
      amount_due: z.number(),
      /** Above max_commission_due: no new cash bookings until paid down. Listed first. */
      over_limit: z.boolean(),
      updated_at: z.string(),
    })
    .openapi('CommissionDue'),
  adjustmentBody: z
    .strictObject({
      owner_type: z.enum(LedgerOwnerType),
      owner_id: objectId,
      /** Signed piastres: + credit, − debit. */
      amount: z
        .number()
        .int()
        .refine((v) => v !== 0, { error: 'validation.invalid_value' }),
      reason: z.string().trim().min(3).max(500),
    })
    .openapi('LedgerAdjustment'),
  exportQuery: z.object({ type: z.enum(REPORT_TYPES), from: date, to: date }),
  payCommissionBody: z
    .strictObject({
      /** Piastres; omit to pay everything owed. */
      amount: z.number().int().min(100).optional(),
      method: z.enum(['card', 'wallet']),
    })
    .openapi('PayCommission'),
  commissionCheckout: z
    .object({ payment_id: objectId, checkout_url: z.string(), amount: z.number(), expires_at: z.string() })
    .openapi('CommissionCheckout'),
};
