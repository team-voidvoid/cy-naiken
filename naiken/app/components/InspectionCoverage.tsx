import type { Diagnosis } from '@/lib/diagnosis-types';
import { inspectionCoverage } from '@/lib/inspection-coverage';

export default function InspectionCoverage({ diagnosis }: { diagnosis: Diagnosis }) {
  const coverage = inspectionCoverage(diagnosis);
  const pending = !['complete', 'failed'].includes(diagnosis.status);
  const available = diagnosis.status === 'complete' && diagnosis.observation?.outcome === 'ok';
  const findings = diagnosis.findings.filter(finding => finding.confidence !== 'unknown');

  return <section className="coverage-card inspection-coverage">
    <p className="mono-label">通常点検の実施状況</p>
    <h2>点検した分野</h2>
    <p className="coverage-value">{coverage.inspectedCount}<span>/ {coverage.total} 分野</span></p>
    <p className="small-note coverage-explanation">点検処理を実行した分野数です。情報の特定率や安全性の達成率ではありません。5分野とも点検済みでも、分からないことは残ります。</p>
    <ul>{coverage.items.map(item => <li key={item.id}>
      <div className="coverage-item-heading"><span>{item.label}</span><span className={item.inspected ? 'inspected-label' : 'unchecked'}>{item.inspected ? '点検済み' : '未点検'}</span></div>
      <p>{item.detail}</p>
    </li>)}</ul>
    <div className="finding-count"><span>通常点検で観測した指摘</span><strong>{available ? <>{findings.length}<small>件</small></> : pending ? '集計中' : '集計対象外'}</strong></div>
    <p className="small-note">{available ? '件数は危険度ではありません。0件でも安全性を保証しません。気になる点は最大3件を表示します。' : pending ? '通常点検が完了すると、指摘の件数を表示します。' : '公開情報を取得できなかった結果を、指摘0件や安全とは扱いません。'} AIの追加調査は別欄に表示します。</p>
  </section>;
}
