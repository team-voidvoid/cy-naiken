CREATE TABLE `diagnoses` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_key` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnoses_cache_key_unique` ON `diagnoses` (`cache_key`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`hits` integer NOT NULL,
	`expires_at` integer NOT NULL
);
