CREATE TABLE `research_jobs` (
	`diagnosis_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
