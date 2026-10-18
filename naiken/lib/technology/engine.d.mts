import type { TechnologyAnalysis, TechnologyPage, TechnologySignal } from './types.ts';
export function detectPageTechnologies(page: TechnologyPage, runtime?: { observations: TechnologySignal[]; status: string }): TechnologyAnalysis;
export function cleanEvidenceUrl(raw: string, base?: string): string | null;
