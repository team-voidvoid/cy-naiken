import { env } from 'cloudflare:workers';
import { allowRequest, fingerprint } from '@/lib/diagnosis-store';
import { createSafetyScoreStore } from '@/lib/safety-score-store';
import { handleSafetyScore } from '@/lib/safety-score-handler';

type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context, start: boolean) {
  const { id } = await context.params;
  if (!env.DB) return Response.json({ error: '評価結果の保存先が利用できません。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const apiKey = env.NAIKEN_DECISIONS_ENABLED === 'false' ? '' : env.OPENAI_API_KEY?.trim();
  return handleSafetyScore(request, id, start, {
    store: createSafetyScoreStore(env.DB), config: apiKey ? { apiKey } : null, allowRequest, fingerprint,
  });
}
export async function GET(request: Request, context: Context) { return handle(request, context, false); }
export async function POST(request: Request, context: Context) { return handle(request, context, true); }
