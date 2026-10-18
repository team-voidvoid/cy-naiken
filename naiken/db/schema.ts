import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const diagnoses = sqliteTable('diagnoses', {
  id: text('id').primaryKey(),
  cacheKey: text('cache_key').notNull().unique(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('diagnoses_public_history_order').on(table.createdAt, table.id).where(sql`json_extract(${table.payload}, '$.mode') = 'live' AND json_extract(${table.payload}, '$.status') IN ('complete', 'preliminary')`),
  index('diagnoses_public_history_url').on(sql`json_extract(${table.payload}, '$.url')`, table.createdAt, table.id).where(sql`json_extract(${table.payload}, '$.mode') = 'live' AND json_extract(${table.payload}, '$.status') IN ('complete', 'preliminary')`),
]);

export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  hits: integer('hits').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const versionExtractions = sqliteTable('version_extractions', {
  cacheKey: text('cache_key').primaryKey(),
  status: text('status').notNull(),
  payload: text('payload'),
  expiresAt: integer('expires_at').notNull(),
}, (table) => [index('version_extractions_expiry').on(table.expiresAt)]);

export const researchJobs = sqliteTable('research_jobs', {
  diagnosisId: text('diagnosis_id').primaryKey(),
  payload: text('payload').notNull(),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
});

export const sitePreviews = sqliteTable('site_previews', {
  url: text('url').primaryKey(),
  payload: text('payload').notNull(),
  nextFetchAt: integer('next_fetch_at').notNull(),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
});
