import { TARGETS } from '@/lib/targets';
export async function GET() { return Response.json({targets:TARGETS}); }
