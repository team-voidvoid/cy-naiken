import { listDiagnosisHistory } from '@/lib/diagnosis-store';
import { InvalidHistoryRequest, parseHistoryOptions } from '@/lib/diagnosis-history';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const options = parseHistoryOptions(new URL(request.url).searchParams);
    return Response.json(await listDiagnosisHistory(options), { headers });
  } catch (error) {
    if (error instanceof InvalidHistoryRequest) return Response.json({ error: error.message }, { status: 400, headers });
    return Response.json({ error: '調査履歴を読み込めませんでした。時間をおいて再度お試しください。' }, { status: 503, headers });
  }
}
