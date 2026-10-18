CREATE TABLE `version_extractions` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`payload` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `version_extractions_expiry` ON `version_extractions` (`expires_at`);