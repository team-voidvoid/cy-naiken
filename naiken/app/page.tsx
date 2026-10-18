'use client';

import { useEffect, useRef, useState } from 'react';
import AgentResearch from './components/AgentResearch';
import DotMascot from './components/DotMascot';
import InspectionProgress from './components/InspectionProgress';
import HistoryBrowser, { SiteHistory } from './components/HistoryBrowser';
import type { AllowedTarget, ComponentInfo, Diagnosis, Evidence } from '@/lib/diagnosis-types';

const categories: Record<string, string> = { headers: '公開ヘッダ', cookies: 'Cookie 属性', https: 'HTTPS', components: '部品・版表記', csrf: 'フォームの手掛かり' };
const confidenceLabels = { confirmed: '確定', inferred: '推測', unknown: '見えない' };
const statusLabels = { observing: '公開情報を取得中', preliminary: '速報をお届けします', matching: '部品の情報を照合中', complete: '内見が完了しました', failed: '内見を完了できませんでした' };

function Arrow({ diagonal = false }: { diagonal?: boolean }) { return <span aria-hidden="true">{diagonal ? '↗' : '→'}</span>; }
function BrandMark() { return <svg viewBox="0 0 40 42" fill="none" aria-hidden="true"><path d="M4 18 20 4l16 14v20H4V18Z" stroke="currentColor" strokeWidth="2.5"/><path d="M15 38V23h12v15M8 15V7h7" stroke="currentColor" strokeWidth="2.5"/><circle cx="22" cy="30" r="1.3" fill="currentColor"/></svg>; }
function formatDate(value?: string) { if (!value) return '未確認'; if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll('-', '/') + '（時刻未記録）'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(date) + ' JST'; }
function EvidenceList({ evidence }: { evidence: Evidence[] }) { return <dl className="evidence-list">{evidence.map((item, index) => <div key={index}><dt>{item.label}{item.ruleId && <small> · {item.ruleId}</small>}</dt><dd><code>{item.value}</code>{item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">出典を開く <Arrow diagonal /></a>}</dd></div>)}</dl>; }
function ComponentRow({ component }: { component: ComponentInfo }) {
  const version = component.version ? `v${component.version}` : component.versionStatus === 'multiple' ? '複数の版の記載・版は未確定' : component.versionStatus === 'incomplete' ? '根拠上限・版は未確定' : '版は未確認';
  return <details className="component-row"><summary>
    <span className="component-year">{component.releaseDate?.slice(0, 4) ?? '—'}</span>
    <span className="component-name">{component.name}<small>{version}</small>{component.versionMethod === 'ai' && <small>AIで版表記を抽出・原文照合済み</small>}{component.package && <small>対応パッケージ {component.package.ecosystem} / {component.package.name}</small>}{component.detectionBasis === 'inferred' && <small>関連技術からの推定</small>}</span>
    <span className="component-support">{component.support ?? '保守状況は未確認'}</span><span className="expand-mark">＋</span>
  </summary><div className="component-detail">
    {component.detectionBasis && <p><span className={`confidence confidence-${component.detectionBasis === 'inferred' || component.detectionConfidence !== 'high' ? 'inferred' : 'confirmed'}`}>{component.detectionBasis === 'inferred' ? '関連技術からの推定・直接観測なし' : component.detectionConfidence === 'high' ? '直接の記載を観測' : '特徴からの候補'}</span></p>}
    {(component.versions?.length ?? 0) > 1 && <p>版の候補：{component.versions!.join(' / ')}。単一の稼働版には決めていません。</p>}
    <p>公開日：{component.releaseDate ?? '未確認'}{component.sourceUrl && <> · <a href={component.sourceUrl} target="_blank" rel="noopener noreferrer">公式の出典 <Arrow diagonal /></a></>}</p>
    <EvidenceList evidence={component.evidence}/>
  </div></details>;
}

async function readJson<T>(response: Response): Promise<T> { const value = await response.json().catch(() => ({})); if (!response.ok) throw new Error((value as { error?: string }).error || '通信に失敗しました。少し待ってからお試しください。'); return value as T; }

export default function Home() {
  const [url, setUrl] = useState('');
  const [targets, setTargets] = useState<AllowedTarget[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [cacheNotice, setCacheNotice] = useState(false);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const requestRef = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/targets').then(readJson<{ targets: AllowedTarget[] }>).then(data => setTargets(data.targets)).catch(() => {});
    function restore() {
      const id = new URLSearchParams(window.location.hash.slice(1)).get('diagnosis');
      if (!id) { requestRef.current++; setDiagnosis(null); setLoadingSaved(false); setBusy(false); setCacheNotice(false); setError(''); return; }
      const request = ++requestRef.current;
      setDiagnosis(null); setCopied(false); setLoadingSaved(true); setBusy(false); setCacheNotice(false); setError('');
      fetch(`/api/diagnoses/${encodeURIComponent(id)}`).then(readJson<Diagnosis>).then(data => { if (request === requestRef.current) setDiagnosis(data); }).catch(err => { if (request === requestRef.current) setError(err.message); }).finally(() => { if (request === requestRef.current) setLoadingSaved(false); });
    }
    restore();
    window.addEventListener('hashchange', restore);
    return () => window.removeEventListener('hashchange', restore);
  }, []);

  useEffect(() => {
    if (!diagnosis || ['complete', 'failed'].includes(diagnosis.status)) return;
    let stopped = false;
    const id = diagnosis.id;
    const request = requestRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const value = await readJson<Diagnosis>(await fetch(`/api/diagnoses/${encodeURIComponent(id)}`, { signal: controller.signal }));
        if (!stopped && request === requestRef.current) { setDiagnosis(value); setError(''); }
      } catch (err) { if (!stopped && request === requestRef.current) setError(err instanceof Error ? err.message : '進捗を取得できませんでした。'); }
    }, 1000);
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [diagnosis]);

  async function start(targetUrl = url.trim()) {
    if (busy) return;
    if (!targetUrl) { setError('内見したいサイトの URL を入力してください。'); return; }
    const request = ++requestRef.current;
    setBusy(true); setError(''); setCopied(false); setCacheNotice(false);
    try {
      const response = await fetch('/api/diagnoses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: targetUrl }) });
      const value = await readJson<Diagnosis>(response);
      if (request !== requestRef.current) return;
      setDiagnosis(value);
      setCacheNotice(response.headers.get('X-Naiken-Cache') === 'hit');
      window.history.replaceState(null, '', `#diagnosis=${encodeURIComponent(value.id)}`);
      window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (err) { if (request === requestRef.current) setError(err instanceof Error ? err.message : '診断を開始できませんでした。'); }
    finally { if (request === requestRef.current) setBusy(false); }
  }
  function reset() { requestRef.current++; setDiagnosis(null); setBusy(false); setLoadingSaved(false); setCacheNotice(false); setError(''); window.history.replaceState(null, '', window.location.pathname + window.location.search); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function navigateTo(section: string) { if (diagnosis || loadingSaved) reset(); window.setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); }
  async function copyLink() { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); window.setTimeout(() => setCopied(false), 2500); } catch { setError('リンクをコピーできませんでした。ブラウザのアドレス欄からコピーしてください。'); } }
  const pending = !!diagnosis && !['complete', 'failed'].includes(diagnosis.status);

  return <div className="site-shell">
    <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); const main = document.getElementById('main'); main?.focus(); main?.scrollIntoView({ block: 'start' }); }}>本文へ移動</a>
    <header className="site-header"><div className="header-topline wrap">Web サービスの中身を確認する、内見ポータル</div><div className="header-inner wrap"><button className="brand" onClick={reset} aria-label="ナイケン ホーム"><BrandMark/><span>ナイケン</span></button><p className="brand-description">個人情報も、お引っ越しの前に。<br/><strong>預ける前に、内見を。</strong></p><span className="prototype-pill">プロトタイプ公開中</span></div><nav className="portal-nav" aria-label="メインナビゲーション"><div className="wrap"><button onClick={() => navigateTo('search')}>URL から内見する <span aria-hidden="true">⌄</span></button><button onClick={() => navigateTo('history')}>みんなの調査を見る <span aria-hidden="true">⌄</span></button><button onClick={() => navigateTo('about')}>ナイケンの使い方 <span aria-hidden="true">⌄</span></button></div></nav></header>
    <main id="main" tabIndex={-1}>
      {loadingSaved && <div className="restore-loading" role="status"><span className="spinner"/> 内見レポートを読み込んでいます…</div>}
      {!diagnosis && !loadingSaved && <>
        <div className="portal-hero-area"><section className="hero wrap"><div className="hero-copy"><p className="hero-pretitle">住所も、免許証も、大切な情報だから。</p><h1>預ける前に、<span>内見を。</span></h1><p className="hero-subtitle">その Web サービス、<strong>中身</strong>まで見て選びませんか？</p><div className="hero-benefits"><span>✓ 部品の公開年</span><span>✓ 公開設定</span><span>✓ 指摘の根拠</span></div></div><div className="hero-mascot-area"><p className="mascot-bubble">外から見えるところを<br/><strong>いっしょにチェック！</strong></p><DotMascot className="hero-mascot"/><span className="mascot-ground"/></div></section>
        <section id="search" className="start-section wrap" aria-labelledby="start-title"><div className="search-tab"><span aria-hidden="true">⌂</span> URL から内見する</div><div className="input-panel"><div className="input-panel-heading"><h2 id="start-title">気になるサイトの URL を入力</h2><span>公開ページだけを点検</span></div><form onSubmit={event => { event.preventDefault(); void start(); }}><label className="sr-only" htmlFor="site-url">内見したいサイトの URL</label><div className="url-input-row"><span className="url-icon" aria-hidden="true">⌕</span><input id="site-url" type="text" inputMode="url" autoCapitalize="off" spellCheck={false} placeholder="https://example.com" value={url} onChange={event => setUrl(event.target.value)} aria-describedby="url-help" disabled={busy}/><button className="primary-button" type="submit" disabled={busy}>{busy ? '受け付けています' : 'このサイトを内見する'}{busy ? <span className="spinner"/> : <Arrow/>}</button></div></form>{busy && <InspectionProgress label="dots がサイトを内見しています" detail="公開情報を取得・解析しています。結果が届くまでお待ちください。"/>}<p id="url-help" className="input-note">調査したURLと結果は、みんなの調査一覧に公開されます。個人用のURLは入力しないでください。ログインが必要なページは確認できません。</p>{targets.length > 0 && <details className="target-picker"><summary><span>URL の入力例を見る</span><span aria-hidden="true">＋</span></summary><div className="target-list">{targets.map(target => <button key={target.url} onClick={() => { setUrl(target.url); document.getElementById('site-url')?.focus(); }}><strong>{target.name}</strong><span>{target.url}</span><Arrow/></button>)}</div></details>}</div></section></div>
        {error && <div className="wrap"><p className="error-message" role="alert">{error}</p></div>}
        <div className="portal-news wrap"><span>ナイケンからのお知らせ</span><p>公開情報を点検し、「確定・推測・見えない」を分けてお伝えします。</p><button onClick={() => navigateTo('about')}>詳しく見る <Arrow/></button></div>
        <HistoryBrowser/>
        <section className="inspection-guide wrap"><div className="section-kicker"><h2><span aria-hidden="true">✓</span> ナイケンで確認できること</h2></div><div className="inspection-grid"><article><span className="guide-icon" aria-hidden="true">⌂</span><div><h3>「築年数」のように、部品の年代を</h3><p>使われているライブラリの版から、公開年や公式の保守状況を確認します。</p><span className="guide-tag">部品の古さ ≠ サイト全体の年齢</span></div></article><article><span className="guide-icon" aria-hidden="true">▦</span><div><h3>「設備」のように、公開設定を</h3><p>HTTPS、ヘッダ、Cookie 属性など、外から確認できる設定を点検します。</p><span className="guide-tag">設定の観測 ≠ 安全性の保証</span></div></article><article><span className="guide-icon" aria-hidden="true">⌕</span><div><h3>気になるところは、根拠まで</h3><p>気になる点は最大3つ。開くと取得した値や出典を確認できます。</p><span className="guide-tag">分からないところは「見えない」</span></div></article></div></section>
        <section id="about" className="about-section"><div className="wrap"><div className="section-kicker"><h2><span aria-hidden="true">?</span> はじめての方へ · 内見はかんたん3ステップ</h2></div><div className="principles"><article><span className="principle-number">1</span><div><h3>URL を入力する</h3><p>気になる Web サービスの公開ページを指定します。個人情報の入力は不要です。</p></div></article><article><span className="principle-number">2</span><div><h3>中身の点検結果を見る</h3><p>部品の情報や公開設定を確認。取得できなかったところも、その理由をお伝えします。</p></div></article><article><span className="principle-number">3</span><div><h3>根拠を見て、判断する</h3><p>指摘の根拠を開いて確認。AI Agent による追加の調査も、別枠で依頼できます。</p></div></article></div><div className="guide-bottom"><DotMascot className="guide-mascot"/><p><strong>分からないことも、きちんとお伝えします。</strong><br/>ログイン後の機能やサーバ内部は見えません。安全性を保証する診断ではありません。</p><button className="primary-button" onClick={() => navigateTo('search')}>さっそく内見する <Arrow/></button></div></div></section>
      </>}
      {diagnosis && <div className="report wrap" ref={resultRef}>
        <div className="report-toolbar"><button className="text-button" onClick={reset}>← 別のサイトを内見する</button><button className="text-button copy-button" onClick={() => void copyLink()}>{copied ? '✓ コピーしました' : 'リンクをコピー'} <span aria-hidden="true">⧉</span></button></div>
        {error && <div className="error-message" role="alert">{error} {pending && <button onClick={() => setDiagnosis({ ...diagnosis })}>進捗を再取得</button>}</div>}
        {cacheNotice && <p className="cache-notice" role="status">保存済みの結果を再利用しています。通常の結果は1週間再利用されます。一時的な通信失敗は30秒後から再試行できます。取得日時をご確認ください。</p>}
        <section className="report-cover"><div className="report-meta"><span className="eyebrow">サイトの内見レポート</span><span className="report-status">{pending && <span className="spinner"/>}{statusLabels[diagnosis.status]}</span></div><div className="report-site"><span className="site-icon"><BrandMark/></span><div><p>{diagnosis.siteName}</p><a href={diagnosis.url} target="_blank" rel="noopener noreferrer">{diagnosis.url} <Arrow diagonal/></a></div></div><h1>{diagnosis.headline || '外から見える情報を、確かめています。'}</h1><p className="report-summary">{diagnosis.summary || '公開ページ、ヘッダ、部品の表記を確認しています。'}</p><div className="cover-bottom"><p>取得日時：{formatDate(diagnosis.observation?.fetchedAt)}</p><span className="report-stamp">外から見える<br/>範囲の点検</span></div></section>
        {busy && <InspectionProgress label="サイトをもう一度、内見しています" detail="公開情報を取得・解析しています。結果が届くまでお待ちください。"/>}
        {pending && !busy && <section className="progress-panel"><InspectionProgress label={statusLabels[diagnosis.status]} detail="このページを開き直しても、続きから確認できます。"/><div className="progress-stages"><span className="active">01 公開情報の取得</span><span className={diagnosis.observation ? 'active' : ''}>02 速報・部品の照合</span><span>03 レポート完成</span></div></section>}
        {diagnosis.error && <p className="error-message" role="alert">{diagnosis.error}</p>}
        {diagnosis.mode === 'live' && <SiteHistory key={`history-${diagnosis.id}`} diagnosis={diagnosis} onRescan={() => void start(diagnosis.url)} busy={busy}/>}
        <AgentResearch key={`research-${diagnosis.id}`} diagnosis={diagnosis}/><div className="report-columns"><div className="report-main"><section className="findings-section"><div className="report-section-heading"><span className="section-number">01</span><h2>このサイトの気になるところ</h2><span>最大3件</span></div><p className="section-caption">観測できた事実から、気になる点を選びました。</p>{diagnosis.findings.length > 0 ? diagnosis.findings.slice(0, 3).map((finding, index) => <details className="finding-card" key={finding.id}><summary><span className="finding-index">{String(index + 1).padStart(2, '0')}</span><div><span className={`confidence confidence-${finding.confidence}`}>{confidenceLabels[finding.confidence]}</span><h3>{finding.title}</h3><p>{finding.explanation}</p><span className="evidence-toggle">根拠を確かめる <span className="expand-mark">＋</span></span></div></summary><div className="finding-detail"><EvidenceList evidence={finding.evidence}/><p className="evidence-note">「確定」は観測事実の確定です。安全性や被害を確定するものではありません。</p></div></details>) : <div className="empty-panel"><span aria-hidden="true">{pending ? '…' : '—'}</span><h3>{pending ? '確認できた点から、順にお伝えします。' : diagnosis.observation?.outcome === 'blocked' ? '取得を拒否されたため、判定していません。' : '現在の観測に基づく指摘はありません。'}</h3><p>指摘がないことは、サイトの安全性を保証しません。</p></div>}</section>
        <section className="components-section"><div className="report-section-heading"><span className="section-number">02</span><h2>部品情報・公開年</h2></div><p className="section-caption">部品の公開年です。サイト全体の年齢ではありません。</p>{diagnosis.observation?.technologyCoverage && <p className="section-caption">公開HTML・ヘッダー・取得したJSを{diagnosis.observation.technologyCoverage.supportedTechnologies}種類の技術の規則と照合しました。ブラウザでの実行後にだけ見える情報は未確認です。</p>}<div className="age-callout"><span>検出した最古の部品</span><strong>{pending && diagnosis.components.some(c => c.version) && !diagnosis.oldestYear ? '照合中' : diagnosis.oldestYear ? <>{diagnosis.oldestYear}<small>年公開</small></> : '未確認'}</strong><p>版が分からない部品の古さは、推測しません。</p></div>{diagnosis.components.length > 0 ? <div className="component-table">{diagnosis.components.map((component, index) => <ComponentRow component={component} key={`${component.name}-${index}`}/>)}</div> : <p className="empty-description">{pending ? '部品の表記を確認しています。' : '公開情報から部品と版を確認できませんでした。'}</p>}</section>
        <section className="unknown-section"><div className="report-section-heading"><span className="section-number">03</span><h2>この点検では、見えないこと。</h2></div><p className="section-caption">外から見えない項目は、採点に含めていません。</p><ul>{(diagnosis.unknowns.length ? diagnosis.unknowns : ['サーバ内部の安全性（SQL インジェクションなど）', 'ログイン後の処理や個人情報の保管方法']).map((item, index) => <li key={index}><span aria-hidden="true">—</span>{item}</li>)}</ul></section></div>
        <aside className="report-sidebar"><section className="coverage-card"><p className="mono-label">今回の点検内容</p><h2>確認できた範囲</h2><p className="coverage-value">{diagnosis.checkedCount}<span>/ 5 項目</span></p><div className="coverage-bars" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <span key={index} className={index < diagnosis.checkedCount ? 'filled' : ''}/>)}</div><ul>{Object.entries(categories).map(([key, label]) => <li key={key}><span>{label}</span><span className={diagnosis.observation?.checkedCategories.includes(key) ? 'checked' : 'unchecked'}>{diagnosis.observation?.checkedCategories.includes(key) ? '✓ 確認' : '未確認'}</span></li>)}</ul><div className="score-display"><span>観測された指摘の合計</span><strong>{diagnosis.score}<small>点</small></strong></div><p className="small-note">点数は危険度ではありません。確認できた範囲に対する指摘の合計で、安全性を保証しません。</p></section><section className="reading-card"><h3>レポートの読み方</h3><p><span className="confidence confidence-confirmed">確定</span> 取得した値に根拠がある</p><p><span className="confidence confidence-inferred">推測</span> 兆候があり、断定できない</p><p><span className="confidence confidence-unknown">見えない</span> 外からは確認できない</p></section><div className="report-note"><p>説明の作成方法</p><strong>{diagnosis.explanationSource === 'agent' ? 'Agent による根拠に基づく説明' : '観測結果に基づく定型文'}</strong>{diagnosis.explanationSource === 'template' && <p>この点検欄は定型文です。AI Agentの追加調査は別欄に表示します。</p>}</div></aside></div>
        <details className="observation-details"><summary>取得・照合の記録 <span className="expand-mark">＋</span></summary><dl><div><dt>対象 URL</dt><dd>{diagnosis.url}</dd></div><div><dt>取得日時</dt><dd>{formatDate(diagnosis.observation?.fetchedAt)}</dd></div><div><dt>最終更新日時</dt><dd>{formatDate(diagnosis.updatedAt)}</dd></div>{diagnosis.observation && <><div><dt>最終 URL</dt><dd>{diagnosis.observation.finalUrl}</dd></div><div><dt>HTTP ステータス</dt><dd>{diagnosis.observation.status || '応答なし'}</dd></div><div><dt>JS の取得</dt><dd>{diagnosis.observation.scriptsFetched} 本取得 / {diagnosis.observation.scriptsSkipped} 本未取得</dd></div><div><dt>取得条件</dt><dd>{diagnosis.observation.userAgent}</dd></div>{diagnosis.observation.message && <div><dt>取得について</dt><dd>{diagnosis.observation.message}</dd></div>}</>}</dl><p>未取得の部品を「存在しない」とは扱いません。ページの取得と、ブラウザ上での動作確認は別です。</p></details>
        <div className="report-end"><BrandMark/><p>判断するための、もうひとつの視点。</p><button className="primary-button" onClick={reset}>別のサイトを内見する <Arrow/></button></div>
      </div>}
    </main>
    <footer className="site-footer"><div className="wrap"><div><span className="footer-brand">ナイケン</span><p>預ける前の、Web サービスの内見。</p></div><p>公開情報だけを点検します。<br/>安全性の保証・脆弱性の実証は行いません。</p><span className="footer-edition">OpenAI DevDay 2026<br/>プロトタイプ</span></div></footer>
  </div>;
}
