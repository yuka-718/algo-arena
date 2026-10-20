import { createApi } from '../shared/api.js';
import { D1Store } from './d1-store.js';
import { assets } from 'arena:assets';

const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/')) {
      if (!env.DB) return Response.json({error:'データベースが準備できていません。'}, {status:503});
      const response = await createApi(new D1Store(env.DB))(request);
      const result = new Response(response.body, response);
      for (const [key,value] of Object.entries(headers)) result.headers.set(key,value);
      return result;
    }
    const asset = assets[pathname];
    if (!asset) return new Response('Not found', {status:404,headers});
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers:{...headers,'Content-Type':asset.type,'Cache-Control':'no-cache'},
    });
  },
};
