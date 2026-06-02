export const config = { runtime: 'edge' };

export default async function handler(request) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ASSEMBLYAI_API_KEY no configurada en el servidor' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const aaiRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await aaiRes.text();
    return new Response(data, {
      status: aaiRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'Falta el parámetro id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const aaiRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${encodeURIComponent(id)}`,
      { headers: { Authorization: apiKey } }
    );
    const data = await aaiRes.text();
    return new Response(data, {
      status: aaiRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method not allowed', { status: 405 });
}
