import type { Diagnosis } from './diagnosis-types.ts';
import type { ResearchView } from './research-types.ts';
import type { ResearchPage } from './research-fetch.ts';
import { inspectPublicPage } from './research-fetch.ts';
import { RESEARCH_INSTRUCTIONS, RESEARCH_SCHEMA, researchInput, validateResearchReport } from './research-report.ts';
import { AgentsApiError, createResearchSession, getResearchSnapshot, submitToolOutput, cancelResearchSession } from './agents-client.ts';
import { normalizeTarget } from './targets.ts';

export const RESEARCH_DEADLINE_MS = 10 * 60_000;
const MAX_CALLS = 12;
type ToolResult = { success: true; output: string } | { success: false; error: string };
export interface ResearchJob extends ResearchView {
  sessionId?: string;
  turnId?: string;
  createAttempted?: boolean;
  startFailure?: { code: string; status?: number; apiCode?: string; requestId?: string; outcomeUnknown: boolean };
  pollFailures?: number;
  lastPolledAt?: number;
  pages: Array<ResearchPage & { requestedUrl: string; evidenceText: string }>;
  outputs: Record<string, { turnId: string; callId: string; result: ToolResult; key: string; submitted: boolean }>;
}
export type AgentConfig = { apiKey: string; model: string };
export const defaultResearchDeps = { create: createResearchSession, snapshot: getResearchSnapshot, submit: submitToolOutput, cancel: cancelResearchSession, inspect: inspectPublicPage, now: () => Date.now() };
export type ResearchDeps = typeof defaultResearchDeps;

export function newResearch(now = Date.now()): ResearchJob {
  const at = new Date(now).toISOString();
  return { id: crypto.randomUUID(), status:'starting', phase:'AI調査を準備しています', startedAt:at, updatedAt:at, sources:[], toolCalls:0, pages:[], outputs:{} };
}
export function researchView(job: ResearchJob): ResearchView {
  const {id,status,phase,startedAt,updatedAt,error,retryable,report,sources,toolCalls} = job;
  return {id,status,phase,startedAt,updatedAt,error,retryable,report,sources,toolCalls};
}
function failed(job: ResearchJob, message: string) {
  job.status = 'failed'; job.phase = 'AI調査を完了できませんでした'; job.error = message; job.retryable = false;
}

// The caller holds a DB lease. Every externally visible action is checkpointed.
export async function advanceResearch(job: ResearchJob, diagnosis: Diagnosis, config: AgentConfig,
  save: (job: ResearchJob) => Promise<void>, deps: ResearchDeps = defaultResearchDeps): Promise<ResearchJob> {
  if (['completed','failed'].includes(job.status)) return job;
  const checkpoint = async () => { job.updatedAt = new Date(deps.now()).toISOString(); await save(job); };
  const stop = async () => {
    if (job.sessionId) { try { await deps.cancel(config, job.sessionId, `naiken-cancel-${job.id}`); } catch { job.error = (job.error ?? '') + ' Agentへの停止通知を確認できませんでした。'; } }
  };
  if (deps.now() - Date.parse(job.startedAt) > RESEARCH_DEADLINE_MS) {
    failed(job, 'AI調査の確認期限を超えました。通常の点検結果をご覧ください。'); await stop(); await checkpoint(); return job;
  }
  if (!job.sessionId) {
    if (job.createAttempted) {
      failed(job, 'Agent開始の応答を確認できませんでした。重複実行を避けるため自動再送しません。管理者によるAPI側の実行確認が必要です。');
      await checkpoint(); return job;
    }
    job.createAttempted = true; await checkpoint();
    try {
      job.sessionId = await deps.create(config, RESEARCH_INSTRUCTIONS, researchInput(diagnosis), RESEARCH_SCHEMA);
      job.status = 'running'; job.phase = 'Agentが調査の進め方を考えています';
    } catch (error) {
      const failure = error instanceof AgentsApiError ? error : null;
      const reasons: Record<number,string> = {
        400:'Agentの開始リクエストが拒否されました。アプリの設定を確認する必要があります。',
        401:'公開環境のAPIキーが認証されませんでした。サーバ側のキー設定を確認してください。',
        403:'Agents APIの利用が許可されませんでした。プロジェクト権限や利用可能な地域を確認してください。',
        404:'指定したモデルまたはAgents APIを利用できませんでした。',
        422:'Agentの開始設定を受け付けてもらえませんでした。',
        429:'APIの利用上限に達しました。利用枠・残高または時間当たりの上限を確認してください。',
      };
      failed(job, (failure?.status && reasons[failure.status]) || failure?.message || 'Agentの開始結果を確認できませんでした。');
      job.startFailure = {code:failure?.code ?? 'unexpected_error',status:failure?.status,apiCode:failure?.apiCode,requestId:failure?.requestId,outcomeUnknown:failure?.outcomeUnknown ?? true};
      job.retryable = !!failure && !failure.outcomeUnknown;
      if (job.retryable) { job.createAttempted = false; job.error += ' 設定を確認した後、再実行できます。'; }
      else job.error += ' 開始結果が不明なため、重複実行を避けて自動再送を止めています。';
      if (failure?.status) job.error += `（HTTP ${failure.status}${failure.apiCode ? ` / ${failure.apiCode}` : ''}）`;
      console.error('Agent session creation failed', JSON.stringify({jobId:job.id,...job.startFailure}));
    }
    await checkpoint(); return job;
  }
  if (job.lastPolledAt && deps.now() - job.lastPolledAt < 4000) return job;
  job.lastPolledAt = deps.now(); await checkpoint();
  try {
    const snapshot = await deps.snapshot(config,job.sessionId,job.turnId);
    if (snapshot.turnId) job.turnId = snapshot.turnId;
    if (snapshot.sessionStatus === 'failed' || ['failed','cancelled'].includes(snapshot.turnStatus ?? '')) {
      failed(job, 'Agent側で調査が終了または中断されました。通常の点検結果をご覧ください。'); await stop();
    } else if (snapshot.needsUnsupportedAction) {
      failed(job, 'この調査では対応していない追加操作が必要になりました。通常の点検結果をご覧ください。'); await stop();
    } else if (snapshot.turnStatus === 'completed') {
      if (!snapshot.outputText || !job.pages.some(page => page.requestedUrl === diagnosis.url)) {
        failed(job, '対象サイトの取得記録または最終レポートを確認できなかったため、AI調査結果を採用しませんでした。');
      } else {
        try {
          job.report = validateResearchReport(snapshot.outputText, job.pages);
          job.status = 'completed'; job.phase = 'AI調査が完了しました';
        } catch { failed(job, 'AI調査結果の形式や根拠を確認できなかったため、通常の点検結果を表示しています。'); }
      }
    } else if (snapshot.requiredCalls.length) {
      // One tool per poll keeps the request short and permits durable resumption.
      const call = snapshot.requiredCalls[0];
      if (!job.turnId) throw new Error('Turn ID unavailable');
      let output = job.outputs[call.callId];
      if (!output) {
        if (job.toolCalls >= MAX_CALLS) {
          failed(job, 'AI調査のページ取得上限に達しました。通常の点検結果をご覧ください。'); await stop(); await checkpoint(); return job;
        }
        job.toolCalls++; job.phase = 'Agentが公開ページや公式資料を確認しています'; await checkpoint();
        let result: ToolResult;
        if (call.name !== 'inspect_public_page' || typeof call.arguments.url !== 'string') {
          result = { success:false,error:'このツールまたは引数は利用できません。' };
        } else {
          try {
            const requestedUrl = normalizeTarget(call.arguments.url).url;
            const page = await deps.inspect(requestedUrl);
            const evidenceText = Object.entries(page.headers).map(([key,value]) => `${key}: ${value}`).join('\n');
            const stored = { ...page, requestedUrl, evidenceText };
            job.pages.push(stored);
            if (page.ok && !job.sources.some(source => source.url === page.url)) job.sources.push({url:page.url,title:page.title || new URL(page.url).hostname});
            result = { success:true,output:JSON.stringify({...page,evidenceText}) };
          } catch { result = {success:false,error:'公開ページを取得できませんでした。内部URLや認証情報付きURLは利用できません。'}; }
        }
        output = { turnId:job.turnId,callId:call.callId,result,key:`naiken-tool-${job.id}-${job.toolCalls}`,submitted:false };
        job.outputs[call.callId] = output;
        await checkpoint();
      }
      // A previously submitted result may be returned again until the API advances.
      // Resending the identical persisted payload with its key is idempotent.
      await deps.submit(config,job.sessionId,{turnId:output.turnId,callId:output.callId},output.result,output.key);
      output.submitted = true;
    } else {
      job.phase = job.toolCalls ? 'Agentが調査結果と根拠をまとめています' : 'Agentが対象サイトの調査を進めています';
    }
    job.pollFailures = 0;
  } catch {
    job.pollFailures = (job.pollFailures ?? 0) + 1;
    job.phase = 'Agentとの接続を再確認しています';
    if (job.pollFailures >= 3) { failed(job, 'Agentとの通信を確認できませんでした。通常の点検結果をご覧ください。'); await stop(); }
  }
  await checkpoint();
  return job;
}
