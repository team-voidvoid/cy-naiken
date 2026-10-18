import type { Diagnosis, DemoKind } from '@/lib/diagnosis-types';
import { normalizeTarget } from '@/lib/targets';
import { observe } from '@/lib/scanner';
import { createDemo, demoList } from '@/lib/demo';
import { allowRequest, fingerprint, reserveDiagnosis, saveDiagnosis } from '@/lib/diagnosis-store';

export async function GET() {
  return Response.json({diagnoses:demoList()}, {headers:{'Cache-Control':'no-store'}});
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({error:'この画面から診断を開始してください。'}, {status:403});
  if (!request.headers.get('content-type')?.includes('application/json')) return Response.json({error:'JSON形式で送信してください。'}, {status:415});
  let body: {url?:unknown;demo?:unknown};
  try {
    const raw = await request.text();
    if (raw.length > 4096) return Response.json({error:'入力が長すぎます。'}, {status:413});
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch { return Response.json({error:'入力を確認してください。'}, {status:400}); }
  try {
    if (body.demo !== undefined) {
      if (!['old','unknown','blocked'].includes(String(body.demo))) return Response.json({error:'サンプルが見つかりません。'}, {status:400});
      const kind = body.demo as DemoKind;
      // Stable sample IDs are independent of the database and never trigger network requests.
      return Response.json({...createDemo(kind, `demo-${kind}`), status:'preliminary'}, {headers:{'Cache-Control':'no-store'}});
    }
    if (typeof body.url !== 'string' || body.url.length > 2048) return Response.json({error:'診断するURLを入力してください。'}, {status:400});
    let target;
    try { target = normalizeTarget(body.url); }
    catch (error) { return Response.json({error:error instanceof Error ? error.message : '対象外のURLです。'}, {status:400}); }
    const visitor = await fingerprint(request.headers.get('oai-authenticated-user-id') || request.headers.get('cf-connecting-ip') || 'local');
    if (!(await allowRequest(`visitor:${visitor}`, 12, 60_000))) return Response.json({error:'少し時間をおいてお試しください。1分間の受付上限に達しました。'}, {status:429,headers:{'Retry-After':'60'}});
    const now = new Date().toISOString();
    const value: Diagnosis = {
      id:crypto.randomUUID(), url:target.url, siteName:target.name, mode:'live',status:'observing',
      createdAt:now,updatedAt:now, findings:[], components:[],headline:'公開情報を確認しています。',
      summary:'対象ページと直接参照する公開ファイルを読み取っています。',score:0,checkedCount:0,
      unknowns:['サーバ内部の安全性や、個人情報の管理状況はこの点検では分かりません。'],explanationSource:'template',
    };
    const reservation = await reserveDiagnosis(value, target.url);
    if (!reservation.owned) return Response.json(reservation.value, {headers:{'Cache-Control':'no-store'}});
    if (!(await allowRequest('global', 20, 60_000)) || !(await allowRequest(`host:${new URL(target.url).hostname}`, 6, 60_000))) {
      const failure:Diagnosis = {...value,status:'failed',error:'受付が混み合っています。時間をおいてお試しください。'};
      await saveDiagnosis(failure);
      return Response.json(failure, {status:429,headers:{'Retry-After':'60'}});
    }
    try {
      const observation = await observe(target.url);
      const preliminary: Diagnosis = {...value, status:'preliminary',updatedAt:new Date().toISOString(),observation,
        findings:observation.findings,components:observation.components,checkedCount:observation.checkedCategories.length,
        headline:'公開情報の取得が終わりました。',summary:'確認済みの部品資料と照合します。'};
      await saveDiagnosis(preliminary, 'observing');
      return Response.json(preliminary, {headers:{'Cache-Control':'no-store'}});
    } catch {
      const failure: Diagnosis = {...value,status:'failed',updatedAt:new Date().toISOString(),error:'取得を完了できませんでした。少し時間をおいてお試しください。'};
      await saveDiagnosis(failure, 'observing');
      return Response.json(failure);
    }
  } catch (error) {
    console.error('Diagnosis request failed', error instanceof Error ? error.message : 'unknown');
    return Response.json({error:'診断の保存に失敗しました。時間をおいて再度お試しください。'}, {status:503});
  }
}
