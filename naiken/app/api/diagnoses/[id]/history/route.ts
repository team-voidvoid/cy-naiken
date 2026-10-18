import { allowRequest, findDiagnosis, fingerprint } from '@/lib/diagnosis-store';
import { archiveTarget, cachedArchiveHistory } from '@/lib/archive-history';

export async function POST(request: Request, context: { params: Promise<{id:string}> }) {
  const headers = { 'Cache-Control': 'no-store' };
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({error:'この画面から履歴調査を開始してください。'}, {status:403,headers});
  const {id} = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({error:'実際の点検結果からお試しください。'}, {status:404,headers});
  try {
    const diagnosis = await findDiagnosis(id);
    if (!diagnosis || diagnosis.mode !== 'live') return Response.json({error:'点検結果が見つかりません。'}, {status:404,headers});
    try { archiveTarget(diagnosis.url); } catch { return Response.json({error:'履歴調査はクエリなしの公開URLでお試しください。'}, {status:400,headers}); }
    const visitor = await fingerprint(request.headers.get('oai-authenticated-user-id') || request.headers.get('cf-connecting-ip') || 'local');
    if (!await allowRequest(`history:${visitor}`, 3, 60_000) || !await allowRequest('history:global', 20, 60_000)) return Response.json({error:'時間をおいて再度お試しください。'}, {status:429,headers});
    return Response.json(await cachedArchiveHistory(diagnosis.url), {headers});
  } catch { return Response.json({error:'履歴を取得できませんでした。'}, {status:503,headers}); }
}
