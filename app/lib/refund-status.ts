import { RefundStatus } from "~/db/schema";

/**
 * The allowed Refund status changes. Issued is final; a Failed Refund can
 * be retried and later marked Issued. Kept out of the `.server` module so
 * the admin screen can offer only the changes the refund module allows.
 */
const ALLOWED_REFUND_CHANGES: Record<RefundStatus, readonly RefundStatus[]> = {
  [RefundStatus.Pending]: [RefundStatus.Issued, RefundStatus.Failed],
  [RefundStatus.Failed]: [RefundStatus.Issued],
  [RefundStatus.Issued]: [],
};

export function canChangeRefundStatus(from: RefundStatus, to: RefundStatus) {
  return ALLOWED_REFUND_CHANGES[from].includes(to);
}
