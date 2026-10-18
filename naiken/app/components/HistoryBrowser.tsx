'use client';

import { useEffect, useRef, useState } from 'react';
import type { Diagnosis } from '@/lib/diagnosis-types';
import type { DiagnosisSummary, HistoryResponse } from '@/lib/history-types';

const dates = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '日時不明' : `${dates.format(date)} JST`;
}

function useHistory(url?: string, enabled = true) {
  const [items, setItems] = useState<DiagnosisSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<string | null>(null);
  const request = useRef(0);
  const paging = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const id = ++request.current;
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: url ? '10' : '9' });
    if (url) params.set('url', url);
    if (query) params.set('q', query);
    if (page) params.set('cursor', page);
    paging.current = true;
    void (async () => {
      await Promise.resolve();
      if (controller.signal.aborted || id !== request.current) return;
      setLoading(true);
      setError('');
      if (!page) { setItems([]); setCursor(null); }
      try {
        const response = await fetch(`/api/history?${params}`, { signal: controller.signal, cache: 'no-store' });
        const body = await response.json() as HistoryResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || '調査履歴を取得できませんでした。');
        if (id !== request.current) return;
        setItems(previous => {
          const merged = page ? [...previous, ...body.diagnoses] : body.diagnoses;
          return merged.filter((item, index) => merged.findIndex(other => other.id === item.id) === index);
        });
        setCursor(body.nextCursor);
      } catch (cause) {
        if (controller.signal.aborted || id !== request.current) return;
        setError(cause instanceof Error ? cause.message : '調査履歴を取得できませんでした。');
      } finally {
        if (id === request.current) { paging.current = false; setLoading(false); }
      }
    })();
    return () => controller.abort();
  }, [url, query, page, revision, enabled]);

  return { items, loading, error, cursor,
    search(value: string) { request.current++; paging.current = true; setLoading(true); setError(''); setItems([]); setCursor(null); setPage(null); setQuery(value.trim()); setRevision(value => value + 1); },
    more() { if (!paging.current && cursor) { paging.current = true; setLoading(true); setPage(cursor); } },
    retry() { paging.current = true; setLoading(true); setError(''); setRevision(value => value + 1); },
  };
}

function ResearchBadge({ status }: { status: DiagnosisSummary['researchStatus'] }) {
  const label = status === 'completed' ? 'AI 調査あり' : status === 'starting' || status === 'running' ? 'AI 調査中' : status === 'failed' ? 'AI 調査未完了' : '公開情報の点検';
  return <span className={`history-badge ${status === 'completed' ? 'history-badge-ai' : ''}`}>{label}</span>;
}

function SiteImage({ item }: { item: DiagnosisSummary }) {
  const [failed, setFailed] = useState(false);
  const hasImage = !!item.imageUrl && !failed;
  return <div className={`history-image ${hasImage ? 'history-image-loaded' : ''}`}>
    {hasImage ? /* eslint-disable-next-line @next/next/no-img-element */
      <img src={`/api/diagnoses/${encodeURIComponent(item.id)}/image`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/> :
      <div className="history-image-fallback"><span aria-hidden="true">⌂</span><span>サイトの内見レポート</span></div>}
    <span className="history-image-caption">{hasImage ? 'サイトの OGP 画像' : 'プレビュー画像なし'}</span>
  </div>;
}

export default function HistoryBrowser() {
  const history = useHistory();
  const [input, setInput] = useState('');
  const [searched, setSearched] = useState(false);
  return <section id="history" className="history-section wrap" aria-labelledby="history-title">
    <div className="section-kicker"><h2 id="history-title"><span aria-hidden="true">⌂</span> みんなの内見レポート</h2><p>サイトごとの最新レポート</p></div>
    <p className="section-lead">ユーザーが調査した公開サイトの結果を共有しています。正常に取得した結果は1週間再利用します。各レポートは記載の取得時点の情報です。</p>
    <form className="history-search" role="search" onSubmit={event => { event.preventDefault(); setSearched(!!input.trim()); history.search(input); }}>
      <label htmlFor="history-query">調査済みのサイトを探す</label>
      <div><input id="history-query" type="search" value={input} onChange={event => setInput(event.target.value)} placeholder="サイト名・URL" maxLength={200}/><button type="submit">検索 <span aria-hidden="true">⌕</span></button></div>
    </form>
    <div className="history-results" aria-busy={history.loading}>
      {history.items.length > 0 && <div className="history-grid">{history.items.map(item => <article className="history-card" key={item.id}>
        <a href={`#diagnosis=${encodeURIComponent(item.id)}`} className="history-card-link">
          <SiteImage item={item}/>
          <div className="history-card-body"><div className="history-card-badges"><ResearchBadge status={item.researchStatus}/>{item.outcome && item.outcome !== 'ok' && <span className="history-badge">取得範囲に制限あり</span>}</div><h3>{item.siteName || item.url}</h3><p className="history-url">{item.url}</p><p className="history-headline">{item.headline || '公開情報の点検レポート'}</p><div className="history-card-bottom"><time dateTime={item.createdAt}>{dateLabel(item.createdAt)}</time><span>レポートを見る <span aria-hidden="true">›</span></span></div></div>
        </a>
      </article>)}</div>}
      {history.loading && <p className="history-feedback" role="status"><span className="spinner" aria-hidden="true"/> 調査履歴を読み込んでいます…</p>}
      {history.error && <div className="history-feedback history-error" role="alert"><p>{history.error}</p><button onClick={history.retry}>もう一度読み込む</button></div>}
      {!history.loading && !history.error && history.items.length === 0 && <div className="history-empty" role="status"><span aria-hidden="true">⌕</span><h3>{searched ? '一致する調査結果はありません' : 'まだ共有された内見レポートはありません'}</h3><p>{searched ? '別のサイト名や URL で検索してください。' : '上の URL 入力欄から調査すると、ここにレポートが並びます。'}</p></div>}
      {history.cursor && !history.error && <div className="history-more"><button disabled={history.loading} onClick={history.more}>さらに見る <span aria-hidden="true">⌄</span></button></div>}
    </div>
  </section>;
}

export function SiteHistory({ diagnosis, onRescan, busy = false }: { diagnosis: Diagnosis; onRescan: () => void; busy?: boolean }) {
  const pending = !['complete', 'failed'].includes(diagnosis.status);
  const history = useHistory(diagnosis.url, diagnosis.mode === 'live' && !pending);
  if (diagnosis.mode !== 'live') return null;
  return <section className="site-history" aria-labelledby="site-history-title">
    <div className="site-history-heading"><div><h2 id="site-history-title">このサイトの調査履歴</h2><p>同じ URL の過去のレポートを、新しい順に確認できます。</p></div><button className="site-history-rescan" onClick={onRescan} disabled={busy || !['complete', 'failed'].includes(diagnosis.status)}>{busy ? <><span className="spinner" aria-hidden="true"/> 確認しています…</> : 'この URL を再確認する'}</button></div>
    <p className="site-history-note">調査結果はみんなで共有されます。正常に取得した結果は1週間再利用し、その後の再確認で新しく調査します。一時的な取得失敗は30秒後から再試行できます。</p>
    <div aria-busy={history.loading}>
      {history.items.length > 0 && <ol className="site-history-list">{history.items.map(item => <li key={item.id} className={item.id === diagnosis.id ? 'site-history-current' : ''}><div><time dateTime={item.createdAt}>{dateLabel(item.createdAt)}</time><ResearchBadge status={item.researchStatus}/>{item.id === diagnosis.id && <span className="site-history-current-label">表示中</span>}</div><p>{item.headline || '公開情報の点検レポート'}</p>{item.id !== diagnosis.id && <a href={`#diagnosis=${encodeURIComponent(item.id)}`}>この時点のレポートを見る <span aria-hidden="true">›</span></a>}</li>)}</ol>}
      {history.loading && <p className="history-feedback" role="status"><span className="spinner" aria-hidden="true"/> {pending ? '調査が完了すると履歴を表示します。' : '履歴を読み込んでいます…'}</p>}
      {history.error && <div className="history-feedback history-error" role="alert"><p>{history.error}</p><button onClick={history.retry}>履歴を再取得</button></div>}
      {!history.loading && !history.error && history.items.length === 0 && <p className="history-feedback">保存済みの調査履歴はまだありません。調査が完了すると表示されます。</p>}
      {history.cursor && !history.error && <div className="history-more"><button disabled={history.loading} onClick={history.more}>以前の履歴をさらに見る <span aria-hidden="true">⌄</span></button></div>}
    </div>
  </section>;
}
