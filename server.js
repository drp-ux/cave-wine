const express = require('express');
const https   = require('https');
const http    = require('http');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// ── /api/wine-image ───────────────────────────────────────────────────────────
// Searches for wine label image via Anthropic web search.
// Returns a proxyUrl (small string) — NOT base64 (which blows localStorage quota).
// Client stores the proxyUrl; /api/proxy-image serves the actual image bytes.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/wine-image', async (req, res) => {
  const { apiKey, producer, wineName, vintage } = req.body || {};
  if (!apiKey || !producer) {
    return res.status(400).json({ proxyUrl: null, error: 'Missing params' });
  }

  const query = [producer, wineName, vintage].filter(Boolean).join(' ');

  const prompt = `Search for a wine bottle label image for: "${query}"

Search vivino.com, wine-searcher.com, and wine retailer sites.
Find a direct image URL (.jpg .jpeg .png .webp) for the wine label or bottle photo.

Return ONLY a raw JSON object:
{"imageUrl":"https://images.vivino.com/thumbs/...","source":"vivino"}

Rules:
- imageUrl must be a direct link to a real image file
- Must be for this specific wine — not a generic photo
- Prefer vivino.com thumbnail images (they are small and fast)
- If not found: {"imageUrl":null}`;

  try {
    const searchRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!searchRes.ok) {
      const err = await searchRes.text();
      return res.json({ proxyUrl: null, error: `API ${searchRes.status}: ${err.slice(0,100)}` });
    }

    const data = await searchRes.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('').trim();

    if (!text) return res.json({ proxyUrl: null });

    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return res.json({ proxyUrl: null });

    let result;
    try { result = JSON.parse(jsonMatch[0]); } 
    catch { return res.json({ proxyUrl: null }); }

    if (!result.imageUrl) return res.json({ proxyUrl: null });

    // Verify the image actually loads before returning
    const valid = await checkImageExists(result.imageUrl);
    if (!valid) return res.json({ proxyUrl: null });

    // Return proxy URL — client stores this tiny string, not the full image
    const proxyUrl = '/api/proxy-image?url=' + encodeURIComponent(result.imageUrl);
    res.json({ proxyUrl, source: result.source || 'unknown' });

  } catch (e) {
    console.error('wine-image error:', e.message);
    res.json({ proxyUrl: null, error: e.message });
  }
});

// ── /api/proxy-image ──────────────────────────────────────────────────────────
// Fetches any image URL server-side and streams it to the client.
// Bypasses CORS/hotlink protection since the request comes from a server.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/proxy-image', (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const protocol = url.startsWith('https') ? https : http;
  const request = protocol.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'image/webp,image/jpeg,image/png,image/*,*/*',
      'Referer': 'https://www.google.com/'
    }
  }, (imgRes) => {
    if (imgRes.statusCode === 301 || imgRes.statusCode === 302) {
      const loc = imgRes.headers.location;
      if (loc) return res.redirect('/api/proxy-image?url=' + encodeURIComponent(loc));
      return res.status(404).end();
    }
    if (imgRes.statusCode !== 200) {
      return res.status(imgRes.statusCode).end();
    }
    const ct = imgRes.headers['content-type'] || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(415).end();
    
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
    res.setHeader('Access-Control-Allow-Origin', '*');
    imgRes.pipe(res);
  });

  request.on('error', e => res.status(500).end());
  request.setTimeout(10000, () => { request.destroy(); res.status(504).end(); });
});

// ── Catch-all: serve index.html ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function checkImageExists(url) {
  return new Promise(resolve => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.request(url, { method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.google.com/'
      }
    }, res => {
      resolve(res.statusCode === 200 && (res.headers['content-type']||'').startsWith('image/'));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Cave Wine server on port ${PORT}`));
