// Hàm được inject vào website; không phụ thuộc biến của service worker.
async function extractUrlPage(mode) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isX = /(^|\.)(x\.com|twitter\.com)$/.test(location.hostname);
  const absolute = value => {
    try { const u = new URL(value, location.href); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
  };
  const imageUrls = root => [...new Set([...root.querySelectorAll(isX ? '[data-testid="tweetPhoto"] img' : 'img')]
    .map(img => absolute(img.currentSrc || img.src)).filter(Boolean))].slice(0, 8);
  if (mode === 'detail') {
    for (let i = 0; i < 15; i++) {
      const articles = [...document.querySelectorAll('article')];
      const root = isX
        ? articles.find(a => [...a.querySelectorAll('a[href]')].some(a => new URL(a.href).pathname === location.pathname && a.querySelector('time')))
        : document.querySelector('article, [itemprop="articleBody"], main');
      if (root && (root.innerText || '').trim().length > 40) {
        if (isX) {
          const more = root.querySelector('[data-testid="tweet-text-show-more-link"]');
          if (more) { more.click(); await sleep(1000); }
        }
        const text = isX ? root.querySelector('[data-testid="tweetText"]')?.innerText : root.innerText;
        const og = !isX && absolute(document.querySelector('meta[property="og:image"]')?.content);
        return { url: location.href, title: document.title, text: (text || '').trim().slice(0, 20000), images: [...new Set([...imageUrls(root), ...(og ? [og] : [])])] };
      }
      await sleep(700);
    }
    throw new Error('Không đọc được nội dung bài: trang có thể yêu cầu đăng nhập hoặc không hỗ trợ cấu trúc này');
  }
  const found = new Map();
  for (let round = 0; round < 6; round++) {
    const roots = [...document.querySelectorAll(isX ? 'article' : 'article, [itemtype*="BlogPosting"], [itemtype*="NewsArticle"], .post, .blog-post')];
    for (const root of roots) {
      if (isX && /pinned|đã ghim/i.test(root.querySelector('[data-testid="socialContext"]')?.innerText || '')) continue;
      const link = isX ? [...root.querySelectorAll('a[href]')].find(a => a.querySelector('time') && /\/status\/\d+/.test(a.href))
        : root.querySelector('h1 a[href], h2 a[href], h3 a[href], a[rel="bookmark"], a[href]');
      const url = absolute(link?.href);
      if (!url || (!isX && new URL(url).origin !== location.origin)) continue;
      const date = Date.parse(root.querySelector('time')?.dateTime || '');
      found.set(url, { url, date: Number.isFinite(date) ? date : 0 });
    }
    window.scrollBy(0, Math.max(600, innerHeight * .8));
    await sleep(900);
  }
  if (!found.size) {
    // Trang danh sách dùng heading thay vì article.
    for (const a of document.querySelectorAll('main h2 a[href], main h3 a[href]')) {
      const url = absolute(a.href);
      if (url && new URL(url).origin === location.origin) found.set(url, { url, date: 0 });
    }
  }
  return [...found.values()].sort((a, b) => b.date - a.date).slice(0, 5);
}

async function waitUrlScanTab(tabId) {
  for (let i = 0; i < 40; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') { await waitMs(1500); return; }
    await waitMs(500);
  }
  throw new Error('Website tải quá lâu');
}

async function scanWebsiteUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Chỉ hỗ trợ URL HTTPS');
  if (!await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) throw new Error('Chưa được cấp quyền truy cập website');
  // Tab riêng cho việc quét; không điều hướng tab đang chạy luồng khác.
  const tab = await chrome.tabs.create({ url: url.href, active: true });
  const read = async mode => {
    await waitUrlScanTab(tab.id);
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractUrlPage, args: [mode] });
    return results[0].result;
  };
  const articles = [], errors = [];
  try {
    const links = /\/status\/\d+/.test(url.pathname) ? [{ url: url.href }] : await read('list');
    if (!links.length) links.push({ url: url.href });
    for (const link of links) {
      try {
        await chrome.tabs.update(tab.id, { url: link.url, active: true });
        const article = await read('detail');
        if (!article?.text) throw new Error('Bài không có nội dung văn bản');
        articles.push({ ...article, timestamp: link.date || 0 });
      } catch (error) { errors.push({ url: link.url, error: error.message }); }
    }
    if (!articles.length) throw new Error(errors.map(e => e.error).join('; ') || 'Không tìm thấy bài đăng');
    return { articles, errors };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (request.action !== 'SCAN_WEBSITE_URL' && request.action !== 'FETCH_SCAN_IMAGE') return;
  const work = request.action === 'SCAN_WEBSITE_URL' ? scanWebsiteUrl(request.url) : (async () => {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || !await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) throw new Error('Chưa được cấp quyền lấy ảnh');
    const response = await fetch(url.href, { credentials: 'omit' });
    if (!response.ok) throw new Error(`Không tải được ảnh: HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size > 10 * 1024 * 1024) throw new Error('Ảnh không hợp lệ hoặc lớn hơn 10 MB');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { dataUrl: `data:${blob.type};base64,${btoa(binary)}` };
  })();
  startKeepAlive();
  work.then(result => respond({ success: true, ...result }), error => respond({ success: false, error: error.message }));
  return true;
});
