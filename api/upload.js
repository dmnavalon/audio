export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ASSEMBLYAI_API_KEY no configurada en el servidor' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const aaiRes = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/octet-stream',
    },
    body: request.body,
    duplex: 'half',
  });

  return new Response(aaiRes.body, {
    status: aaiRes.status,
    headers: {
      'Content-Type': aaiRes.headers.get('content-type') || 'application/json',
    },
  });
}
