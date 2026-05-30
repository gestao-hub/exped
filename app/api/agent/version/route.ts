import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Versão mais recente do agente publicada. O agente compara com a sua própria
 * versão e avisa no log se estiver desatualizado. Override por env AGENT_LATEST_VERSION.
 */
export async function GET() {
  const latest = process.env.AGENT_LATEST_VERSION ?? '1.0.0';
  return NextResponse.json({ latest });
}
