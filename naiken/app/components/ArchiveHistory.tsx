'use client';
import { useEffect, useState } from 'react';
import type { ArchiveHistory as History } from '@/lib/archive-history';
import type { Diagnosis } from '@/lib/diagnosis-types';

function date(timestamp: string) { return `${timestamp.slice(0,4)}-${timestamp.slice(4,6)}-${timestamp.slice(6,8)}`; }
export default function ArchiveHistory({ diagnosis }: { diagnosis: Diagnosis }) {
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);
  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setRetrySeconds(remaining);
      if (!remaining) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  if (diagnosis.mode !== 'live') return null;
  function waitToRetry(seconds = 30) {
    const delay = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 30;
    setRetryAt(Date.now() + delay * 1000);
    setRetrySeconds(delay);
  }
  async function load() {
    if (busy || retrySeconds > 0) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/diagnoses/${encodeURIComponent(diagnosis.id)}/history`, { method: 'POST' });
      const value = await response.json() as History & { error?: string };
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'));
        waitToRetry(retryAfter > 0 ? retryAfter : 30);
        throw new Error(value.error || '履歴を取得できませんでした。');
      }
      setHistory(value);
      if (value.status === 'unavailable') waitToRetry(value.failure?.retryAfterSeconds ?? 30);
    } catch (e) { setError(e instanceof Error ? e.message : '履歴を取得できませんでした。'); }
    finally { setBusy(false); }
  }
  return <section className="archive-history findings-section" aria-label="部品の保存履歴">
    <div className="report-section-heading"><h2>部品の保存履歴</h2></div>
    <p className="section-caption">Internet Archive の保存ページから、部品・版の表記の変化を調べます。入力URLを Internet Archive に照会します。</p>
    {(!history || history.status === 'unavailable') && <button className="archive-button" disabled={busy || retrySeconds > 0} onClick={load}>{busy ? '保存履歴を確認中…' : retrySeconds > 0 ? `再確認まで ${retrySeconds} 秒` : history || error ? 'Internet Archive の履歴を再確認する' : 'Internet Archive で履歴を調べる'}</button>}
    {error && <p role="alert">{error}</p>}
    {history && <>
      <p>{history.fromYear}–{history.toYear} 年 ／ HTML確認 {history.snapshots.filter(s => s.status === 'observed').length} 件 ／ 取得候補 {history.snapshots.length} 件（最大4件）</p>
      <p className="evidence-note">確認日時: {history.checkedAt} ／ {history.note}</p>
      {history.status === 'unavailable' && <p role="status">{history.failure?.message || '保存記録がないか、アクセス制限・通信状況などにより履歴を確認できませんでした。'}</p>}
      <ul>{history.snapshots.map(s => <li key={s.timestamp}>
        <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">{date(s.timestamp)} の保存ページ</a>
        {s.status === 'unavailable' ? <p>{s.failure?.message || '本文未確認。'} 比較対象にしていません。</p> : <>
          <p>JS本文確認 {s.scriptsRead} 件 ／ 未確認・対象外 {s.scriptsSkipped} 件{s.truncated ? ' ／ 一部のみ解析' : ''}</p>
          {s.scriptsRead === 0 && s.scriptsSkipped > 0 && <p>JS本文はHTMLと保存日時が一致するものだけを確認します。近い日時の保存JSは採用しないため、版不明でも保存ページがないとは限りません。</p>}
          <ul>{s.components.map(c => <li key={c.technologyId || c.name}>{c.name}: {c.version || '版不明・複数候補'}{c.detectionBasis === 'inferred' ? '（関連技術からの推定）' : c.versionStatus === 'referenced' ? '（参照URLの表記）' : '（保存内容の表記）'}
            {c.evidence.slice(0, 2).map((e,i) => <span key={i}> <a href={e.url} target="_blank" rel="noopener noreferrer">根拠{i+1}</a></span>)}</li>)}</ul>
          {!s.components.length && <p>対応する部品の表記を検出できませんでした。</p>}
        </>}
      </li>)}</ul>
      <h3>標本間で観測できた版表記の変化: {history.changes.length} 件</h3>
      {history.changes.length ? <ul>{history.changes.map((c,i) => <li key={i}>{c.name}: {c.fromVersion} → {c.toVersion}（{date(c.from)} ～ {date(c.to)} の標本間）</li>)}</ul> : <p>比較可能な標本間の版表記の変化は確認できませんでした。更新がなかったという意味ではありません。</p>}
    </>}
  </section>;
}
