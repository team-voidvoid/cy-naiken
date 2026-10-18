import { findDiagnosis, findSitePreview } from '@/lib/diagnosis-store';
import { fetchSitePreviewImage, unavailablePreviewImage } from '@/lib/site-preview';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return unavailablePreviewImage();
  try {
    const diagnosis = await findDiagnosis(id);
    if (diagnosis?.mode !== 'live' || diagnosis.observation?.outcome !== 'ok') return unavailablePreviewImage();
    const imageUrl = diagnosis.observation.preview?.imageUrl ?? (await findSitePreview(diagnosis.url))?.imageUrl;
    return imageUrl ? await fetchSitePreviewImage(imageUrl) : unavailablePreviewImage();
  } catch {
    return unavailablePreviewImage();
  }
}
