'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import DotMascot from './DotMascot';
import InspectionProgress from './InspectionProgress';
import SafetyScore, { type SafetyScoreProgress } from './SafetyScore';
import type { Diagnosis } from '@/lib/diagnosis-types';

import type { ResearchResponse, ResearchView } from '@/lib/research-types';

class ResearchApiError extends Error {
  constructor(message: string, readonly notStarted: boolean, readonly unconfigured: boolean) { super(message); }
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function sourceName(value: string): string {
  try { return new URL(value).hostname; } catch { return '出典'; }
}
function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '日時を確認できません' : new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo',
  }).format(date) + ' JST';
}
function isActive(research: ResearchView | null | undefined) {
  return research?.status === 'starting' || research?.status === 'running';
}
async function parseResponse(response: Response): Promise<ResearchResponse> {
  const data = await response.json().catch(() => null) as (ResearchResponse & { error?: string; started?: boolean }) | null;
  if (!response.ok) {
    const message = response.status === 429 ? 'ただいま利用が集中しています。少し時間をおいて、もう一度お試しください。' : data?.error || '調査の状況を取得できませんでした。少し時間をおいてお試しください。';
    throw new ResearchApiError(message, data?.started === false, data?.configured === false);
  }
  if (!data || typeof data.configured !== 'boolean' || !('research' in data)) {
    throw new Error('調査の状況を読み取れませんでした。状況を再取得してください。');
  }
  return data;
}

export default function AgentResearch({ diagnosis }: { diagnosis: Diagnosis }) {
  const eligible = diagnosis.mode === 'live' && diagnosis.status === 'complete';
  const [snapshot, setSnapshot] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState('');
  const [startError, setStartError] = useState('');
  const [posting, setPosting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [startUncertain, setStartUncertain] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scoreRequest, setScoreRequest] = useState(0);
  const [scoreProgress, setScoreProgress] = useState<SafetyScoreProgress>('checking');
  const identity = useRef(diagnosis.id);
  const sequence = useRef(0);
  const postController = useRef<AbortController | null>(null);
  const endpoint = `/api/diagnoses/${encodeURIComponent(diagnosis.id)}/research`;
  const scoreIntentKey = `naiken-score-intent:${diagnosis.id}`;

  useEffect(() => {
    // Resume this tab's explicit request after a reload, without making other
    // visitors start a paid evaluation merely by opening the shared report.
    try { setScoreRequest(sessionStorage.getItem(scoreIntentKey) === 'requested' ? 1 : 0); }
    catch { setScoreRequest(0); }
    setScoreProgress('checking');
  }, [scoreIntentKey]);

  const scoreStarted = useCallback(() => {
    // Consume the intent before sending POST. Unknown responses must not be
    // automatically resent after reload; the saved reservation is read instead.
    try { sessionStorage.removeItem(scoreIntentKey); } catch { /* Storage is optional. */ }
  }, [scoreIntentKey]);

  function requestScore() {
    try { sessionStorage.setItem(scoreIntentKey, 'requested'); } catch { /* Continue in memory. */ }
    setScoreRequest(value => value + 1);
  }

  useEffect(() => {
    return () => { postController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (identity.current !== diagnosis.id) {
      identity.current = diagnosis.id;
      sequence.current++;
      postController.current?.abort();
      setSnapshot(null); setError(''); setStartError(''); setStartUncertain(false); setPosting(false); setPaused(false);
    }
    if (!eligible || posting || paused) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const request = ++sequence.current;
    async function update() {
      setRefreshing(true);
      const timeout = setTimeout(() => controller.abort(), 70000);
      try {
        const value = await parseResponse(await fetch(endpoint, { signal: controller.signal, cache: 'no-store' }));
        if (disposed || request !== sequence.current) return;
        setSnapshot(value); setError('');
        if (value.research) { setStartUncertain(false); setStartError(''); }
        if (isActive(value.research)) timer = setTimeout(() => void update(), 5000);
      } catch (cause) {
        if (!disposed && request === sequence.current) setError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '時間内に状況を取得できませんでした。状況を再取得してください。');
      } finally {
        clearTimeout(timeout);
        if (!disposed && request === sequence.current) setRefreshing(false);
      }
    }
    void update();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [diagnosis.id, eligible, endpoint, posting, paused, refreshKey]);

  async function startResearch() {
    if (postController.current || posting || startUncertain) return;
    if (snapshot?.research?.status === 'completed' && snapshot.research.report) {
      if (scoreProgress === 'ready') requestScore();
      return;
    }
    if (!snapshot?.configured || (snapshot.research && (snapshot.research.status !== 'failed' || snapshot.research.retryable !== true))) return;
    requestScore();
    const request = ++sequence.current;
    const controller = new AbortController();
    postController.current = controller;
    setPosting(true); setPaused(false); setError(''); setStartError('');
    const timeout = setTimeout(() => controller.abort(), 70000);
    try {
      const value = await parseResponse(await fetch(endpoint, { method: 'POST', signal: controller.signal }));
      if (request !== sequence.current) return;
      setSnapshot(value); setStartUncertain(false);
    } catch (cause) {
      if (request !== sequence.current) return;
      setStartUncertain(!(cause instanceof ResearchApiError && cause.notStarted));
      if (cause instanceof ResearchApiError && cause.unconfigured) setSnapshot(value => ({ configured: false, research: value?.research ?? null }));
      setStartError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '時間内に調査の開始状況を確認できませんでした。');
    } finally {
      clearTimeout(timeout);
      if (request === sequence.current) { setPosting(false); postController.current = null; }
    }
  }
  function refresh() { setPaused(false); setRefreshKey(value => value + 1); }
  const research = snapshot?.research;
  const active = isActive(research);
  const researchComplete = research?.status === 'completed' && !!research.report;
  const visibleError = error || startError;

  if (!eligible) return null;

  return <section className="agent-research" aria-labelledby="agent-heading">
    <div className="agent-heading"><div className="agent-advisor"><DotMascot/><div><p className="eyebrow">もう少し詳しく知りたい方へ</p><h2 id="agent-heading">AIの内見カウンター</h2></div></div><span className="agent-label">追加調査</span></div>
    <p className="agent-intro">1回のクリックで、AIによる追加調査から安全スコアの算出まで進みます。公開情報を内見して根拠を整理した後、通常点検の結果を使って自動でスコアリングします。</p>
    <ol className="agent-steps" aria-label="AI内見と安全スコアの流れ">
      <li className={researchComplete ? 'is-complete' : 'is-current'} aria-current={researchComplete ? undefined : 'step'}><span aria-hidden="true">01</span><div><strong>AIで詳しく内見</strong><p>公開情報と根拠を確認</p></div>{researchComplete && <span className="agent-step-done">完了</span>}</li>
      <li className={scoreProgress === 'completed' ? 'is-complete' : researchComplete ? 'is-current' : ''} aria-current={researchComplete && scoreProgress !== 'completed' ? 'step' : undefined}><span aria-hidden="true">02</span><div><strong>続けてスコアリング</strong><p>{scoreProgress === 'completed' ? '参考スコアを算出しました' : scoreProgress === 'scoring' ? '確認できた公開情報を評価中' : scoreProgress === 'failed' || scoreProgress === 'unavailable' || scoreProgress === 'uncertain' ? '評価の状況を下の欄で確認できます' : researchComplete ? '保存済みのAI内見を使って評価へ進みます' : 'AI内見の完了後に自動で開始します'}</p></div>{scoreProgress === 'completed' && <span className="agent-step-done">完了</span>}</li>
    </ol>

    {!snapshot && !visibleError && <p className="agent-status" role="status"><span className="spinner"/> 調査の準備状況を確認しています。</p>}
    {snapshot && !snapshot.configured && !research && <div className="agent-setup"><span className="agent-ready-dot" aria-hidden="true"/><div><strong>追加調査の画面は準備できています。</strong><p>API キーがまだ設定されていないため、現在は実行できません。</p></div><span className="agent-setup-badge">接続待ち</span></div>}
    {((snapshot?.configured && !research) || (researchComplete && scoreProgress === 'ready')) && !startUncertain && <div className="agent-start"><button className="primary-button" onClick={() => void startResearch()} disabled={posting || refreshing}>{posting ? <><span className="spinner"/> 調査を受け付けています</> : <>AIで内見・スコアリング <span aria-hidden="true">↗</span></>}</button><p>{researchComplete ? '保存済みのAI内見を再利用し、未実施のスコアリングへ進みます。' : '公開情報をOpenAIへ送信してAI調査を行い、完了後に続けて参考スコアを算出します。'} ログインやフォームの送信は行いません。</p></div>}
    {visibleError && <div className="agent-error" role="alert"><p>{visibleError}</p>{startUncertain && <p>開始できたかを確認中です。重複した調査を避けるため、再送せずに状況を確認します。</p>}<button className="text-button" onClick={refresh} disabled={refreshing || posting}>{refreshing ? '確認しています…' : '状況を再取得する'} <span aria-hidden="true">↻</span></button></div>}
    {startUncertain && !visibleError && <div className="agent-error" role="status"><p>開始状況をまだ確認できません。時間をおいて、状況を再取得してください。調査の開始は再送しません。</p><button className="text-button" onClick={refresh} disabled={refreshing}>状況を再取得する <span aria-hidden="true">↻</span></button></div>}
    {(posting || active) && <div className="agent-progress">
      <InspectionProgress
        label={posting ? 'AIの追加調査を受け付けています。' : paused ? '自動更新を停止しています。' : research?.status === 'starting' ? 'AIの調査を準備しています。' : 'AIが公開情報と根拠を確認しています。'}
        detail={paused ? '最後に取得した調査状況を表示しています。Agent 側の処理は継続します。' : visibleError ? '最後に取得した調査状況を表示しています。状況を再取得してください。' : 'このページを開き直しても、続きから確認できます。'}
        paused={paused}
      />
      {!posting && research?.updatedAt && <span className="agent-update-time">最終更新 {timestamp(research.updatedAt)}</span>}
      {!posting && <div className="agent-progress-controls">{paused ? <><button className="text-button" onClick={refresh}>自動更新を再開する <span aria-hidden="true">↻</span></button><span>Agent 側の処理は継続しますが、ページ取得ツールの実行と結果保存は画面再表示または自動更新の再開時に再開します。</span></> : <><button className="text-button" onClick={() => setPaused(true)}>自動更新を止める</button><span>停止中も Agent 側の処理は継続しますが、ページ取得ツールの実行と結果保存は画面再表示または自動更新の再開時に再開します。</span></>}</div>}
    </div>}
    {!posting && research?.status === 'failed' && <div className="agent-failed"><strong>追加調査を完了できませんでした。</strong><p>{research.error || '調査先から結果を受け取れませんでした。上の点検結果はそのまま確認できます。'}</p>{research.retryable !== true && <p>再実行には管理者による確認が必要です。上の点検結果は引き続き確認できます。</p>}{snapshot?.configured && research.retryable === true && !startUncertain && <button className="primary-button" onClick={() => void startResearch()} disabled={refreshing}>AI内見・スコアリングをやり直す <span aria-hidden="true">↗</span></button>}</div>}
    {!posting && research?.status === 'completed' && <div className="agent-result"><div className="agent-result-meta"><span><span aria-hidden="true">✓</span> AI の追加調査が完了しました</span><span>{timestamp(research.updatedAt)}</span></div>{research.report ? <><p className="agent-result-summary">{research.report.summary}</p><div className="agent-findings">{research.report.findings.map((finding, index) => <details className="agent-finding" key={`${index}-${finding.title}`}><summary><span className="agent-finding-index">{String(index + 1).padStart(2, '0')}</span><div><span className={`confidence confidence-${finding.confidence === 'unknown' ? 'unknown' : 'inferred'}`}>{finding.confidence === 'unknown' ? '見えない' : '推測'}</span><h3>{finding.title}</h3><p>{finding.detail}</p><span className="agent-evidence-label">根拠を確かめる</span></div><span className="expand-mark" aria-hidden="true">＋</span></summary><div className="agent-evidence">{finding.evidence.length ? finding.evidence.map((evidence, evidenceIndex) => { const href = safeUrl(evidence.url); return <div key={evidenceIndex}>{evidence.quote && <blockquote>{evidence.quote}</blockquote>}{href ? <a href={href} target="_blank" rel="noopener noreferrer">{sourceName(href)} <span aria-hidden="true">↗</span></a> : <p className="small-note">出典のリンクを表示できません。</p>}</div>; }) : <p>表示できる根拠はありません。この項目は未確認の情報として扱ってください。</p>}</div></details>)}</div>{research.report.findings.length === 0 && <p className="agent-no-findings">追加で指摘できる点はありませんでした。サイトの安全性を保証するものではありません。</p>}{research.report.limitations.length > 0 && <div className="agent-limitations"><h3>今回の追加調査で、分からなかったこと</h3><ul>{research.report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></div>}</> : <p className="agent-no-findings">調査は完了しましたが、表示できるレポートはありません。上の点検結果をご確認ください。</p>}{research.sources.length > 0 && <details className="agent-sources"><summary>調査で参照した公開情報 <span className="expand-mark" aria-hidden="true">＋</span></summary><ul>{research.sources.map((source, index) => { const href = safeUrl(source.url); return href ? <li key={index}><a href={href} target="_blank" rel="noopener noreferrer">{source.title || sourceName(href)} <span aria-hidden="true">↗</span></a><span>{sourceName(href)}</span></li> : null; })}</ul></details>}</div>}
    {!posting && researchComplete && <SafetyScore key={`safety-${diagnosis.id}`} diagnosis={diagnosis} startRequest={scoreRequest} onStarted={scoreStarted} onProgress={setScoreProgress}/>}
    <p className="agent-boundary">AI の説明には誤りが含まれる場合があります。出典とあわせてご確認ください。AI内見と安全スコアは安全性を保証しません。通常点検の指摘件数とAIの追加調査は分けて表示します。</p>
  </section>;
}
