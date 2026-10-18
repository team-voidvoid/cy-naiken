import { evaluateSafety, safetyState, safetyUnavailableReason } from './safety-score.ts';
import type { DecisionsConfig } from './decisions-client.ts';
import type { SafetyScoreStore } from './safety-score-store.ts';

interface Dependencies {
  store: SafetyScoreStore; config: DecisionsConfig | null;
  allowRequest: (key: string, maximum: number, windowMs: number) => Promise<boolean>;
  fingerprint: (value: string) => Promise<string>;
}
const headers = { 'Cache-Control': 'no-store' };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });

export async function handleSafetyScore(request: Request, id: string, start: boolean, deps: Dependencies): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return reply({ error: '実際のサイトの点検結果から評価してください。' }, 400);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return reply({ error: 'この画面から操作してください。' }, 403);
  try {
    const diagnosis = await deps.store.read(id);
    if (!diagnosis) return reply({ error: '点検結果が見つかりません。' }, 404);
    const configured = !!deps.config;
    // Check the saved research before exposing legacy scores or starting Decisions.
    if (!await deps.store.researchCompleted(id)) {
      return reply({ configured, assessment: null, unavailableReason: 'AIの内見が完了してから安全性を評価できます。' });
    }
    if (diagnosis.safetyScore?.status === 'scoring' && Date.now() - Date.parse(diagnosis.safetyScore.updatedAt) > 60_000) {
      await deps.store.finish(id, safetyState('failed', '評価が中断されたか、結果を保存できませんでした。重複実行を防ぐため自動再送しません。'));
      diagnosis.safetyScore = (await deps.store.read(id))?.safetyScore;
    }
    if (diagnosis.safetyScore) return reply({ configured, assessment: diagnosis.safetyScore });
    const unavailableReason = safetyUnavailableReason(diagnosis);
    if (unavailableReason) return reply({ configured, assessment: null, unavailableReason });
    // GET is read-only except for expiring a stale reservation. It never calls OpenAI.
    if (!start || !deps.config) return reply({ configured, assessment: null });
    const visitor = await deps.fingerprint(request.headers.get('cf-connecting-ip') || 'anonymous');
    if (!(await deps.allowRequest(`decisions:${visitor}`, 3, 60_000)) || !(await deps.allowRequest('decisions:global', 10, 60_000))) {
      return Response.json({ error: '安全性評価の受付上限です。1分ほどお待ちください。' }, { status: 429, headers: { ...headers, 'Retry-After': '60' } });
    }
    if (!await deps.store.reserve(id, safetyState('scoring'))) {
      return reply({ configured, assessment: (await deps.store.read(id))?.safetyScore ?? null }, 202);
    }
    const result = await evaluateSafety(diagnosis, deps.config);
    await deps.store.finish(id, result);
    return reply({ configured, assessment: (await deps.store.read(id))?.safetyScore ?? result });
  } catch {
    return reply({ error: '安全性評価の状態を確認できませんでした。状況を再取得してください。' }, 503);
  }
}
