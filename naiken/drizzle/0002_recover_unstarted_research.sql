-- This particular attempt was checked against the complete Agents session list.
-- No session was created at 2026-10-18T05:43:16Z. Allow an explicit retry only.
UPDATE research_jobs
SET payload = json_set(payload, '$.retryable', json('true'), '$.createAttempted', json('false'), '$.error', '前回はAgentが開始されていないことを確認しました。追加調査を再実行できます。')
WHERE diagnosis_id = '84f0a098-1896-484b-be88-f4a3fa99fef5'
  AND json_extract(payload, '$.id') = '870f0f10-e8c4-453b-8b12-416e6339c28f'
  AND json_extract(payload, '$.status') = 'failed'
  AND json_extract(payload, '$.sessionId') IS NULL;
