CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_request_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`status_changed_at` text,
	`status_changed_by_user_id` integer,
	FOREIGN KEY (`refund_request_id`) REFERENCES `refund_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`status_changed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_refund_request_id_unique` ON `refunds` (`refund_request_id`);--> statement-breakpoint
-- Hand-written backfill: every Approved Refund Request gets a Pending Refund
-- for the full amount paid on its purchase. Runs before amount_refunded goes.
INSERT INTO `refunds` (`refund_request_id`, `amount`, `status`, `created_at`, `status_changed_at`, `status_changed_by_user_id`)
SELECT `refund_requests`.`id`, `purchases`.`amount_paid`, 'pending', COALESCE(`refund_requests`.`resolved_at`, `refund_requests`.`requested_at`), `refund_requests`.`resolved_at`, `refund_requests`.`resolved_by_user_id`
FROM `refund_requests`
INNER JOIN `purchases` ON `purchases`.`id` = `refund_requests`.`purchase_id`
WHERE `refund_requests`.`status` = 'approved';--> statement-breakpoint
ALTER TABLE `refund_requests` DROP COLUMN `amount_refunded`;