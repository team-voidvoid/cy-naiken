CREATE TABLE `site_previews` (
	`url` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`next_fetch_at` integer NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
