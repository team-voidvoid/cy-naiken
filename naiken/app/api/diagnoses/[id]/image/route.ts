import { findDiagnosis } from '@/lib/diagnosis-store';
import { fetchSitePreviewImage, unavailablePreviewImage } from '@/lib/site-preview';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return unavailablePreviewImage();
  try {
    const diagnosis = await findDiagnosis(id);
    const imageUrl = diagnosis?.mode === 'live' && diagnosis.observation?.outcome === 'ok' ? diagnosis.observation.preview?.imageUrl : undefined;
    return imageUrl ? await fetchSitePreviewImage(imageUrl) : unavailablePreviewImage();
  } catch {
    return unavailablePreviewImage();
  }
}
