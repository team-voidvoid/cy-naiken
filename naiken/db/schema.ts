import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const diagnoses = sqliteTable('diagnoses', {
  id: text('id').primaryKey(),
  cacheKey: text('cache_key').notNull().unique(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  hits: integer('hits').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const researchJobs = sqliteTable('research_jobs', {
  diagnosisId: text('diagnosis_id').primaryKey(),
  payload: text('payload').notNull(),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
});
