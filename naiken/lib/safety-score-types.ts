export const SAFETY_MODEL = 'gpt-6-luna';
export const SAFETY_RUBRIC_VERSION = 'public-signals-v1';

export const SAFETY_LEVELS = [
  { label: '重大な懸念が複数', description: '平文HTTPでの応答など強い懸念に、複数の観測上の不備が重なっている。' },
  { label: '大きな懸念', description: '平文HTTPでの応答、または公式サポート対象外の部品と複数の設定不備が観測されている。' },
  { label: '複数の改善点', description: 'CSPなど複数の保護設定が確認できず、改善を検討する材料がある。強い懸念は観測されていない。' },
  { label: '軽微な改善点', description: '観測された不備が限定的、または推測にとどまり、強い懸念の根拠はない。' },
  { label: '観測上の懸念が少ない', description: '確認できた項目に目立った不備がない。未確認部分を安全と評価する意味ではない。' },
] as const;

export interface SafetyProbability { value: number; label: string; probability: number }
interface SafetyScoreBase { model: string; rubricVersion: string; updatedAt: string }
export type SafetyScore = SafetyScoreBase & (
  | { status: 'scoring' }
  | { status: 'completed'; score: number; rawScore: number; confidence: number; probabilities: SafetyProbability[] }
  | { status: 'unavailable' | 'failed'; message: string }
);
export interface SafetyScoreResponse { configured: boolean; assessment: SafetyScore | null; unavailableReason?: string }
