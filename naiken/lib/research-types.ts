export interface ResearchEvidence { url: string; quote: string }
export interface ResearchReport {
  summary: string;
  findings: Array<{ title: string; detail: string; confidence: 'inferred' | 'unknown'; evidence: ResearchEvidence[] }>;
  limitations: string[];
}
export interface ResearchSource { url: string; title: string }
export interface ResearchView {
  id: string;
  status: 'starting' | 'running' | 'completed' | 'failed';
  phase: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  retryable?: boolean;
  report?: ResearchReport;
  sources: ResearchSource[];
  toolCalls: number;
}
export interface ResearchResponse { configured: boolean; research: ResearchView | null }
