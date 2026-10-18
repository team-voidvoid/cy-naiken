export interface TechnologyPage {
  url: string;
  body: string;
  headers: Record<string, string | string[]>;
}

export interface TechnologySignal {
  type: string;
  key: string;
  value: string;
  sourceUrl: string;
  location: Record<string, string | number | boolean>;
}

export type VersionStatus = 'declared' | 'referenced' | 'runtime' | 'multiple' | 'incomplete' | 'unknown';
export interface PackageIdentity { name: string; ecosystem: 'npm' }
export interface TechnologyEvidence {
  ruleId: string;
  confidence: 'high' | 'medium';
  value: string;
  sourceUrl: string | null;
  claimedVersion: string | null;
  versionBasis: string | null;
}
export interface TechnologyDetection {
  id: string;
  name: string;
  package: PackageIdentity | null;
  confidence: 'high' | 'medium';
  confidenceScore: number;
  detectionBasis: 'observed' | 'inferred';
  inferredFrom?: string[];
  version: string | null;
  versionStatus: VersionStatus;
  versions: Array<{ version: string; basis: string; confidence: string; evidenceIndexes: number[] }>;
  evidence: TechnologyEvidence[];
}
export interface TechnologyAnalysis {
  detections: TechnologyDetection[];
  supportedTechnologies: ReadonlyArray<{ id: string; name: string }>;
  coverage: { htmlParsedCompletely: boolean; evidenceTruncated: boolean; observedSignalTypes: string[] };
}
