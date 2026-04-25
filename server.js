// Cave Wine — Node.js server
// Serves the static app + proxies wine label images (bypasses CORS/hotlink blocking)

const express = require('express');
const https   = require('https');
const http    = require('http');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// ── /api/wine-image ───────────────────────────────────────────────────────────
// Searches for wine label image via Anthropic web search, fetches it server-side,
// and returns it as a base64 data URL — bypasses all CDN hotlink protection.
//
// POST body: { apiKey, producer, wineName, vintage }
// Response:  { imageDataUrl: "data:image/jpeg;base64,...", source: "vivino" }
//            { imageDataUrl: null }  (if not found)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/wine-image', async (req, res) => {
  const { apiKey, producer, wineName, vintage } = req.body || {};
  if (!apiKey || !producer) {
    return res.status(400).json({ imageDataUrl: null, error: 'Missing apiKey or producer' });
  }

  const query = [producer, wineName, vintage].filter(Boolean).join(' ');

  const prompt = `Search for a wine bottle label image for: "${query}"

Search vivino.com, wine-searcher.com, and wine retailer sites.
Find a direct image URL for the wine label or bottle photo.

Return ONLY a raw JSON object, nothing else before or after it:
{"imageUrl":"https://images.vivino.com/thumbs/...","source":"vivino"}

Rules:
- imageUrl must be a direct link to an image file (.jpg .jpeg .png .webp)
- Prefer vivino.com or wine-searcher.com images
- Must be for the specific producer and wine, not a generic photo
- If you cannot find a real image URL: {"imageUrl":null,"reason":"not found"}`;

  try {
    // Step 1: Ask Anthropic (with web search) to find the image URL
    const searchRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!searchRes.ok) {
      const err = await searchRes.text();
      return res.json({ imageDataUrl: null, error: `API ${searchRes.status}: ${err.slice(0, 100)}` });
    }

    const data = await searchRes.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('').trim();

    if (!text) return res.json({ imageDataUrl: null, error: 'Empty response' });

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return res.json({ imageDataUrl: null, error: 'No JSON in response' });

    let result;
    try { result = JSON.parse(jsonMatch[0]); }
    catch { return res.json({ imageDataUrl: null, error: 'JSON parse failed' }); }

    if (!result.imageUrl) return res.json({ imageDataUrl: null });

    // Step 2: Fetch the image server-side (bypasses browser CORS/hotlink restrictions)
    const imageDataUrl = await fetchImageAsBase64(result.imageUrl);
    res.json({ imageDataUrl, source: result.source || 'unknown' });

  } catch (e) {
    console.error('wine-image error:', e.message);
    res.json({ imageDataUrl: null, error: e.message });
  }
});

// ── /api/proxy-image ──────────────────────────────────────────────────────────
// Simple image proxy: fetches any image URL server-side and streams it back.
// Usage: /api/proxy-image?url=https://...
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
    // Follow redirects
    if (imgRes.statusCode === 301 || imgRes.statusCode === 302) {
      const location = imgRes.headers.location;
      if (location) return res.redirect('/api/proxy-image?url=' + encodeURIComponent(location));
    }
    if (imgRes.statusCode !== 200) {
      return res.status(imgRes.statusCode).json({ error: 'Image fetch failed' });
    }
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
    res.setHeader('Access-Control-Allow-Origin', '*');
    imgRes.pipe(res);
  });

  request.on('error', e => res.status(500).json({ error: e.message }));
  request.setTimeout(10000, () => {
    request.destroy();
    res.status(504).json({ error: 'Timeout' });
  });
});

// ── Catch-all: serve index.html ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function fetchImageAsBase64(url) {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/webp,image/jpeg,image/png,image/*',
        'Referer': 'https://www.google.com/'
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return fetchImageAsBase64(loc).then(resolve);
        return resolve(null);
      }
      if (res.statusCode !== 200) return resolve(null);

      const contentType = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 1000) return resolve(null); // Too small = not a real image
        if (buffer.length > 2 * 1024 * 1024) {
          // Compress large images by returning the URL instead for proxy
          resolve(null);
          return;
        }
        const base64 = buffer.toString('base64');
        resolve(`data:${contentType};base64,${base64}`);
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cave Wine server running on port ${PORT}`);
});
