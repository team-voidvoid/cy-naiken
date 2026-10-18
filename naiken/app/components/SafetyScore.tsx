'use client';

import { useEffect, useRef, useState } from 'react';
import type { Diagnosis } from '@/lib/diagnosis-types';
import { SAFETY_LEVELS, type SafetyScoreResponse } from '@/lib/safety-score-types';

class ScoreRequestError extends Error {
  constructor(message: string, readonly notStarted = false) { super(message); }
}
async function read(response: Response): Promise<SafetyScoreResponse> {
  const data = await response.json().catch(() => null) as (SafetyScoreResponse & { error?: string }) | null;
  if (!response.ok) throw new ScoreRequestError(data?.error || '安全性評価の状態を取得できませんでした。', response.status >= 400 && response.status < 500);
  if (!data || typeof data.configured !== 'boolean' || !('assessment' in data)) throw new ScoreRequestError('安全性評価の結果を読み取れませんでした。');
  return data;
}

export default function SafetyScore({ diagnosis }: { diagnosis: Diagnosis }) {
  const [snapshot, setSnapshot] = useState<SafetyScoreResponse | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [startError, setStartError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const post = useRef<AbortController | null>(null);
  const endpoint = `/api/diagnoses/${encodeURIComponent(diagnosis.id)}/safety-score`;
  const eligible = diagnosis.mode === 'live' && diagnosis.status === 'complete';

  useEffect(() => () => { const controller = post.current; post.current = null; controller?.abort(); }, []);
  useEffect(() => {
    if (!eligible || posting) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function update() {
      const deadline = setTimeout(() => controller.abort(), 20_000);
      try {
        const value = await read(await fetch(endpoint, { signal: controller.signal, cache: 'no-store' }));
        if (disposed) return;
        setSnapshot(value); setError('');
        if (value.assessment) { setUncertain(false); setStartError(''); }
        if (value.assessment?.status === 'scoring') timer = setTimeout(() => void update(), 2000);
      } catch {
        if (!disposed) setError('安全性評価の状態を取得できませんでした。状況を再取得してください。');
      } finally { clearTimeout(deadline); }
    }
    void update();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [eligible, endpoint, posting, refresh]);

  async function score() {
    if (posting || uncertain || !snapshot?.configured || snapshot.assessment || snapshot.unavailableReason) return;
    const controller = new AbortController(); post.current = controller;
    setPosting(true); setError(''); setStartError('');
    const deadline = setTimeout(() => controller.abort(), 25_000);
    try {
      const value = await read(await fetch(endpoint, { method: 'POST', signal: controller.signal }));
      if (!controller.signal.aborted) { setSnapshot(value); setUncertain(false); }
    } catch (cause) {
      if (post.current === controller) {
        setUncertain(!(cause instanceof ScoreRequestError && cause.notStarted));
        setStartError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '評価の受付結果を確認できませんでした。');
      }
    } finally { clearTimeout(deadline); if (post.current === controller) { setPosting(false); post.current = null; } }
  }

  if (diagnosis.mode === 'demo') return <section className="safety-score-panel"><h2>URLの安全性スコア</h2><p>サンプルは過去の部分的な記録のため採点しません。実際の公開サイトの内見後に評価できます。</p></section>;
  if (!eligible) return null;
  const assessment = snapshot?.assessment;
  return <section className="safety-score-panel" aria-labelledby="safety-score-heading">
    <div className="safety-score-heading"><div><p className="eyebrow">公開情報に基づく参考評価</p><h2 id="safety-score-heading">URLの安全性スコア</h2></div><span className="agent-label">Decisions API</span></div>
    <p>確認できた保護設定と部品情報をAIが評価します。高いほど、確認範囲で観測された懸念が少ないことを表します。</p>
    {!snapshot && !error && <p role="status"><span className="spinner"/> 評価の準備状況を確認しています。</p>}
    {snapshot?.unavailableReason && <p className="safety-score-note">{snapshot.unavailableReason}</p>}
    {snapshot && !snapshot.configured && !assessment && !snapshot.unavailableReason && <p className="safety-score-note">APIキーの設定後に安全性評価を利用できます。</p>}
    {snapshot?.configured && !assessment && !snapshot.unavailableReason && !uncertain && <div className="safety-score-start"><button className="primary-button" onClick={() => void score()} disabled={posting}>{posting ? <><span className="spinner"/> 評価しています</> : '安全性をスコアリング'}</button><p>サイトのオリジンと点検の観測項目をOpenAIへ送信します。URLのパス・クエリやページ本文は送りません。</p></div>}
    {assessment?.status === 'scoring' && <p role="status"><span className="spinner"/> 安全性を評価しています。この結果URLから再表示できます。</p>}
    {assessment?.status === 'completed' && <div className="safety-score-result">
      <div className="safety-score-value"><strong>{assessment.score}<small> / 100</small></strong><div><span>確認範囲 {diagnosis.checkedCount} / 5 項目</span><span>評価確信度 {Math.round(assessment.confidence * 100)}%</span></div></div>
      <meter min={0} max={100} value={assessment.score} aria-label="公開情報に基づく安全性の参考スコア"/>
      <p className="small-note">評価確信度はAIの段階評価への確信度で、安全である確率ではありません。</p>
      <details className="safety-score-details"><summary>評価基準と段階別の分布を見る</summary><p>0〜4の段階スコアを100点に換算しています。観測した根拠は下の点検項目で確認できます。</p><ol start={0}>{SAFETY_LEVELS.map((level, index) => <li key={level.label}><strong>{level.label}<span>{Math.round((assessment.probabilities.find(item => item.value === index)?.probability ?? 0) * 100)}%</span></strong><p>{level.description}</p></li>)}</ol><p>モデル：{assessment.model} · 評価基準：{assessment.rubricVersion}</p><p>評価日時：{new Date(assessment.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST</p></details>
    </div>}
    {(assessment?.status === 'failed' || assessment?.status === 'unavailable') && <p className="safety-score-note" role="status">{assessment.message} 点検結果は引き続き確認できます。</p>}
    {(error || startError) && <p className="error-message" role="alert">{error || startError}</p>}
    {uncertain && <p>受付結果が不明なため再送していません。状況を再取得してください。</p>}
    {(error || startError || uncertain) && <button className="text-button" onClick={() => setRefresh(value => value + 1)} disabled={posting}>状況を再取得する ↻</button>}
    <p className="safety-score-boundary">安全性の保証や危険度の確率ではありません。詐欺・マルウェアの有無、サーバ内部、ログイン後の処理や個人情報の保管方法は未確認です。既存の「観測された指摘の合計」とは別の評価です。</p>
  </section>;
}
