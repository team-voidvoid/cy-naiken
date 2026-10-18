-- The Worker rejected redirect:error before dispatching this attempt.
-- Only the inspected failure is reset; no unknown or running session is retried.
UPDATE research_jobs
SET payload = json_set(payload, '$.retryable', json('true'), '$.createAttempted', json('false'), '$.error', '通信設定の問題を修正しました。前回はAgentが開始されていないため、追加調査を再実行できます。')
WHERE diagnosis_id = '84f0a098-1896-484b-be88-f4a3fa99fef5'
  AND json_extract(payload, '$.id') = '67961101-698b-44a9-b3f7-6577d57250e5'
  AND json_extract(payload, '$.status') = 'failed'
  AND json_extract(payload, '$.startFailure.code') = 'network_error'
  AND json_extract(payload, '$.sessionId') IS NULL;
