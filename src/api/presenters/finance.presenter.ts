import type { IWalletLedgerEntry } from '../../interfaces/ILedger';
import type { IPayout, IPayoutMethod } from '../../interfaces/IPayout';
import { maskedLabel } from '../../services/payouts/payout.service';

/** Maps earnings, ledger and payouts to the API shapes in finance.validation.ts. */

export const presentPayoutMethod = (m: IPayoutMethod | null) =>
  m
    ? {
        type: m.type,
        account_holder: m.accountHolder,
        bank_name: m.bankName,
        wallet_provider: m.walletProvider,
        account_number_last4: m.accountNumber.slice(-4),
        label: maskedLabel(m),
      }
    : null;

export const presentLedgerEntry = (e: IWalletLedgerEntry) => ({
  id: String(e._id),
  type: e.type,
  amount: e.amount,
  balance_after: e.balanceAfter,
  booking_id: e.bookingId ? String(e.bookingId) : null,
  note: e.note,
  created_at: e.createdAt.toISOString(),
});

export const presentPayout = (p: IPayout) => ({
  id: String(p._id),
  amount: p.amount,
  status: p.status,
  destination: p.destinationLabel,
  /** How the amount came together: card earnings − commission for cash bookings ± the rest = net paid. */
  statement: {
    card_earnings: p.statement?.cardEarnings ?? 0,
    commission_deducted: p.statement?.commissionDeducted ?? 0,
    commission_paid: p.statement?.commissionPaid ?? 0,
    other_deductions: p.statement?.otherDeductions ?? 0,
    adjustments: p.statement?.adjustments ?? 0,
    net: p.statement?.net ?? p.amount,
  },
  batch_date: p.batchDate,
  reference: p.reference,
  paid_at: p.paidAt ? p.paidAt.toISOString() : null,
  created_at: p.createdAt.toISOString(),
});
