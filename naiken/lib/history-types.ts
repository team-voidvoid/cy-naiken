import type { Diagnosis, Observation } from './diagnosis-types';
import type { ResearchView } from './research-types';

/** Public listing projection. Never contains saved research session credentials or raw observations. */
export interface DiagnosisSummary {
  id: string;
  url: string;
  siteName: string;
  status: Extract<Diagnosis['status'], 'preliminary' | 'complete'>;
  createdAt: string;
  updatedAt: string;
  headline: string;
  summary: string;
  checkedCount: number;
  score: number;
  outcome?: Observation['outcome'];
  imageUrl?: string;
  researchStatus?: ResearchView['status'];
}

export interface HistoryResponse {
  diagnoses: DiagnosisSummary[];
  nextCursor: string | null;
}
