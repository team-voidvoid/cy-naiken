import { env } from 'cloudflare:workers';
import type { ResearchJob } from './research-engine';

function db() { if (!env.DB) throw new Error('保存先が利用できません。'); return env.DB; }
export async function readResearch(id: string): Promise<ResearchJob | null> {
  const row = await db().prepare('SELECT payload FROM research_jobs WHERE diagnosis_id = ?').bind(id).first<{payload:string}>();
  return row ? JSON.parse(row.payload) : null;
}
export async function insertResearch(id: string, job: ResearchJob): Promise<boolean> {
  const row = await db().prepare('INSERT INTO research_jobs (diagnosis_id,payload,lease_until) VALUES (?,?,0) ON CONFLICT DO NOTHING RETURNING diagnosis_id').bind(id, JSON.stringify(job)).first();
  return !!row;
}
export async function acquireResearch(id: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const row = await db().prepare('UPDATE research_jobs SET lease_token = ?, lease_until = ? WHERE diagnosis_id = ? AND lease_until < ? RETURNING diagnosis_id').bind(token, Date.now() + 90_000, id, Date.now()).first();
  return row ? token : null;
}
export async function writeResearch(id: string, token: string, job: ResearchJob): Promise<void> {
  const row = await db().prepare('UPDATE research_jobs SET payload = ? WHERE diagnosis_id = ? AND lease_token = ? AND lease_until >= ? RETURNING diagnosis_id').bind(JSON.stringify(job),id,token,Date.now()).first();
  if (!row) throw new Error('調査の更新権限が失効しました。');
}
export async function releaseResearch(id: string, token: string): Promise<void> {
  await db().prepare('UPDATE research_jobs SET lease_until = 0, lease_token = NULL WHERE diagnosis_id = ? AND lease_token = ?').bind(id,token).run();
}
