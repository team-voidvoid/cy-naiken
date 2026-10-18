import type { Diagnosis } from '@/lib/diagnosis-types';
import { findDiagnosis, saveDiagnosis } from '@/lib/diagnosis-store';
import { finalizeObservation } from '@/lib/rules';

export async function GET(_request: Request, context: {params:Promise<{id:string}>}) {
  const {id} = await context.params;
  const headers = {'Cache-Control':'no-store'};
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({error:'診断結果が見つかりません。'}, {status:404,headers});
  try {
    const value = await findDiagnosis(id);
    if (!value) return Response.json({error:'診断結果が見つかりません。'}, {status:404,headers});
    if (value.status === 'preliminary' && value.observation) {
      const result:Diagnosis = {...value,...finalizeObservation(value.observation),status:'complete',updatedAt:new Date().toISOString()};
      await saveDiagnosis(result, 'preliminary');
      return Response.json(result,{headers});
    }
    if (value.status === 'observing' && Date.now()-Date.parse(value.createdAt)>60_000) {
      const result:Diagnosis = {...value,status:'failed',error:'取得処理が中断されました。時間をおいて再度お試しください。',updatedAt:new Date().toISOString()};
      await saveDiagnosis(result, 'observing');
      return Response.json(result,{headers});
    }
    return Response.json(value,{headers});
  } catch {
    return Response.json({error:'結果を読み込めませんでした。再度お試しください。'},{status:503,headers});
  }
}
