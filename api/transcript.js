export const config = { runtime: 'edge' };

export default async function handler(request) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return jsonError('ASSEMBLYAI_API_KEY no configurada en el servidor', 500);
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

  if (request.method === 'GET' || request.method === 'DELETE') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return jsonError('Falta el parámetro id', 400);
    const aaiRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${encodeURIComponent(id)}`,
      { method: request.method, headers: { Authorization: apiKey } }
    );
    const data = await aaiRes.text();
    return new Response(data, {
      status: aaiRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return jsonError('Method not allowed', 405);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
