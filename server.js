```js
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const sharp = require('sharp');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const MAX_IMAGES = 12;
const CONNECTION_BYTES_PER_SECOND = 700000;

function normalizeInputUrl(value) {
  if (!value) return '';

  let url = String(value).trim();

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  return url;
}

function isImageLike(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }

  const clean = url.split('?')[0].toLowerCase();

  return (
    clean.endsWith('.jpg') ||
    clean.endsWith('.jpeg') ||
    clean.endsWith('.png') ||
    clean.endsWith('.webp') ||
    clean.endsWith('.avif') ||
    clean.endsWith('.gif') ||
    url.includes('image') ||
    url.includes('cdn')
  );
}

function absoluteUrl(src, baseUrl) {
  if (!src) return null;

  const clean = String(src).trim();

  if (
    !clean ||
    clean.startsWith('data:') ||
    clean.startsWith('blob:')
  ) {
    return null;
  }

  try {
    return new URL(clean, baseUrl).href;
  } catch {
    return null;
  }
}

function parseSrcset(srcset, baseUrl) {
  if (!srcset) return [];

  return String(srcset)
    .split(',')
    .map(item => item.trim().split(/\s+/)[0])
    .map(src => absoluteUrl(src, baseUrl))
    .filter(Boolean);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0'
    }
  });

  if (!response.ok) {
throw new Error('HTTP ' + response.status);

}

  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept': 'image/*'
    }
  });

  if (!response.ok) {
throw new Error('Image HTTP ' + response.status);
}

  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('image')) {
    throw new Error('Not image');
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

function addImage(map, url, sourceType) {

  if (!url || typeof url !== 'string') {
    return;
  }

  if (!isImageLike(url)) {
    return;
  }

  const normalized = url.replace(/#.*$/, '');

  if (!map.has(normalized)) {
    map.set(normalized, {
      url: normalized,
      sourceType
    });
  }
}

async function collectImages(pageUrl) {

  const html = await fetchText(pageUrl);

  const $ = cheerio.load(html);

  const images = new Map();

  $('img').each((_, el) => {

    const attrs = [
      'src',
      'data-src',
      'data-lazy-src',
      'data-original',
      'data-image'
    ];

    attrs.forEach(attr => {

      const value = $(el).attr(attr);

      const imageUrl = absoluteUrl(value, pageUrl);

      addImage(images, imageUrl, `img:${attr}`);
    });

    parseSrcset($(el).attr('srcset'), pageUrl)
      .forEach(url => {
        addImage(images, url, 'img:srcset');
      });

  });

  $('source').each((_, el) => {

    parseSrcset($(el).attr('srcset'), pageUrl)
      .forEach(url => {
        addImage(images, url, 'source:srcset');
      });

  });

  return [...images.values()].slice(0, MAX_IMAGES);
}

async function optimizeImage(buffer) {

  const metadata = await sharp(buffer).metadata();

  if (metadata.format === 'svg') {
    return buffer;
  }

  return sharp(buffer)
    .rotate()
    .webp({ quality: 75 })
    .toBuffer();
}

app.post('/api/analyze', async (req, res) => {

  try {

    const pageUrl = normalizeInputUrl(req.body.url);

    if (!pageUrl) {
      return res.status(400).json({
        error: 'URL gerekli.'
      });
    }

    const imageCandidates = await collectImages(pageUrl);

    const results = [];

    let originalBytes = 0;
    let optimizedBytes = 0;

    for (const item of imageCandidates) {

      try {

        const originalBuffer = await fetchBuffer(item.url);

        const optimizedBuffer = await optimizeImage(originalBuffer);

        const original = originalBuffer.length;

        const optimized = Math.min(
          optimizedBuffer.length,
          original
        );

        const saved = Math.max(original - optimized, 0);

        originalBytes += original;
        optimizedBytes += optimized;

        results.push({
          url: item.url,
          sourceType: item.sourceType,
          originalBytes: original,
          optimizedBytes: optimized,
          savedBytes: saved,
          savingPercent:
            original > 0
              ? Math.round((saved / original) * 100)
              : 0
        });

      } catch (error) {

        console.log(
          'Image skipped:',
          item.url,
          error.message
        );

      }

    }

    const savedBytes = Math.max(
      originalBytes - optimizedBytes,
      0
    );

    const savingPercent =
      originalBytes > 0
        ? Math.round((savedBytes / originalBytes) * 100)
        : 0;

    res.json({
      success: true,
      url: pageUrl,
      imageCount: results.length,
      originalBytes,
      optimizedBytes,
      savedBytes,
      savingPercent,
      originalSeconds:
        originalBytes / CONNECTION_BYTES_PER_SECOND,
      optimizedSeconds:
        optimizedBytes / CONNECTION_BYTES_PER_SECOND,
      estimatedSecondsSaved:
        savedBytes / CONNECTION_BYTES_PER_SECOND,
      images: results
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });

  }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Analyzer çalışıyor: ${PORT}`);
});
```


