import { env } from 'cloudflare:workers';
import { findDiagnosis, allowRequest, fingerprint } from '@/lib/diagnosis-store';
import { readResearch, insertResearch, acquireResearch, writeResearch, releaseResearch } from '@/lib/research-store';
import { advanceResearch, newResearch, researchView } from '@/lib/research-engine';

const headers = { 'Cache-Control': 'no-store' };
function config() {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.NAIKEN_AGENT_MODEL?.trim() || 'gpt-6.1-sol';
  return apiKey ? {apiKey,model} : null;
}
const reply = (value: unknown, status = 200) => Response.json(value, {status,headers});

type Context = { params: Promise<{id:string}> };
async function handle(request: Request, context: Context, start: boolean) {
  const {id} = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return reply({error:'実際のサイトの点検結果からAI調査を開始してください。',started:false},400);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return reply({error:'この画面から操作してください。',started:false},403);
  try {
    const diagnosis = await findDiagnosis(id);
    if (!diagnosis) return reply({error:'点検結果が見つかりません。',started:false},404);
    const settings = config();
    if (!settings) return reply({configured:false,research:null,...(start ? {error:'APIキーの設定後にAI調査を利用できます。',started:false} : {})},start ? 503 : 200);
    if (diagnosis.mode !== 'live' || diagnosis.status !== 'complete') return reply({error:'通常の点検が完了してからAI調査を開始してください。',started:false},409);
    let job = await readResearch(id);
    const retry = job?.status === 'failed' && job.retryable === true && !job.sessionId;
    if (start && (!job || retry)) {
      // Public research does not require sign-in. Use the edge-provided IP,
      // never a client-supplied forwarding header; missing IPs share one limit.
      const visitor = await fingerprint(request.headers.get('cf-connecting-ip') || 'anonymous');
      if (!(await allowRequest(`agent:${visitor}`,3,60_000)) || !(await allowRequest('agent:global',10,60_000))) return Response.json({error:'AI調査の受付上限です。1分ほどお待ちください。',started:false},{status:429,headers:{...headers,'Retry-After':'60'}});
      if (!job) await insertResearch(id,newResearch());
      job = await readResearch(id);
    }
    if (!job) return reply({configured:true,research:null});
    if (job.status === 'completed' || (job.status === 'failed' && !(start && retry))) return reply({configured:true,research:researchView(job)});
    // GET resumes saved jobs; it never creates an unsolicited new research session.
    const lease = await acquireResearch(id);
    if (lease) {
      try {
        let current = await readResearch(id);
        if (start && current?.status === 'failed' && current.retryable === true && !current.sessionId) {
          current = newResearch();
          await writeResearch(id,lease,current);
        }
        if (current) job = await advanceResearch(current,diagnosis,settings,value=>writeResearch(id,lease,value));
      } finally { await releaseResearch(id,lease); }
    }
    return reply({configured:true,research:researchView(job)});
  } catch {
    return reply({error:'AI調査の状態を確認できませんでした。開始ボタンを繰り返さず、状況を再取得してください。'},503);
  }
}
export async function GET(request:Request,context:Context) { return handle(request,context,false); }
export async function POST(request:Request,context:Context) { return handle(request,context,true); }
