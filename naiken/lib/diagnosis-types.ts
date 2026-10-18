export type Confidence = 'confirmed' | 'inferred' | 'unknown';
export type DiagnosisStatus = 'observing' | 'preliminary' | 'matching' | 'complete' | 'failed';
export type DemoKind = 'old' | 'unknown' | 'blocked';
export interface Evidence { label: string; value: string; url?: string }
export interface Finding {
  id: string; category: 'headers' | 'cookies' | 'https' | 'components' | 'csrf';
  title: string; explanation: string; confidence: Confidence; points: number; evidence: Evidence[];
}
export interface ComponentInfo {
  name: string; version?: string; evidence: Evidence[]; releaseDate?: string;
  support?: string; sourceUrl?: string; verified?: boolean;
}
export interface Observation {
  url: string; finalUrl: string; status: number; fetchedAt: string;
  bytes: number; hash?: string; userAgent: string;
  outcome: 'ok' | 'blocked' | 'timeout' | 'error'; message?: string;
  findings: Finding[]; components: ComponentInfo[];
  checkedCategories: string[]; scriptsFetched: number; scriptsSkipped: number;
}
export interface Diagnosis {
  id: string; url: string; siteName: string; mode: 'live' | 'demo';
  demoKind?: DemoKind; status: DiagnosisStatus; createdAt: string; updatedAt: string;
  observation?: Observation; findings: Finding[]; components: ComponentInfo[];
  headline: string; summary: string; score: number; checkedCount: number;
  oldestYear?: number; unknowns: string[]; error?: string;
  explanationSource: 'template' | 'agent';
}
export interface AllowedTarget { url: string; name: string; description: string }
