// ============== TIMER KHÔNG BỊ LÀM CHẬM KHI TRANG X BỊ ẨN / CHE KHUẤT ==============
// Khi cửa sổ chứa tab X bị che khuất hoặc thu nhỏ (VD: đang dùng 1 profile Chrome khác đè lên), Chrome coi trang
// là "ẩn" và làm chậm setTimeout: tối thiểu 1 giây/lần (hàm gõ từng ký tự 30ms/ký tự sẽ chậm gấp ~30 lần) và sau
// ~5 phút còn 1 phút/lần. Timer của service worker (background.js) thì không bị vậy -> khi trang đang ẩn, mọi
// setTimeout trong file này được chuyển sang nhờ background "ngủ" hộ rồi báo lại. Trang đang hiển thị bình
// thường thì vẫn dùng timer gốc. Lỗi kết nối tới background (extension vừa tải lại...) thì tự rơi về timer gốc.
(function installHiddenAwareTimeout() {
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const ID_BASE = 2e9;
  let nextId = ID_BASE;
  const pending = new Set();

  function bgSleep(ms, done) {
    let left = Math.max(0, ms);
    const step = () => {
      if (left <= 0) return done();
      const chunk = Math.min(left, 15000);
      const fallback = () => nativeSetTimeout(() => { left -= chunk; step(); }, chunk);
      try {
        chrome.runtime.sendMessage({ action: 'BG_SLEEP', ms: chunk }, (res) => {
          if (chrome.runtime.lastError || !res) return fallback();
          left -= chunk;
          step();
        });
      } catch (e) {
        fallback();
      }
    };
    step();
  }

  window.setTimeout = function (fn, ms, ...args) {
    if (typeof fn !== 'function' || !document.hidden) return nativeSetTimeout(fn, ms, ...args);
    const id = nextId++;
    pending.add(id);
    bgSleep(Number(ms) || 0, () => {
      if (!pending.delete(id)) return; // đã bị clearTimeout
      fn(...args);
    });
    return id;
  };

  window.clearTimeout = function (id) {
    if (typeof id === 'number' && id >= ID_BASE) { pending.delete(id); return; }
    nativeClearTimeout(id);
  };
})();

// content.js - Chạy trực tiếp trên https://x.com/*

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SCRAPE_KOL_PROJECT_TWEET') {
    scrapeKolProjectTweet(request.projectUsername)
      .then((tweet) => sendResponse({ success: true, tweet }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Content Crypto: quét các bài GỐC mới nhất trên trang cá nhân 1 tài khoản (x.com/<tên>).
  if (request.action === 'CRYPTO_SCRAPE_ACCOUNT') {
    cryptoScrapeAccountTweets(request.limit)
      .then((tweets) => sendResponse({ success: true, tweets }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'SCRAPE_TOP_5_UNPINNED_TWEETS') {
    scrapeTop5UnpinnedTweets()
      .then((tweets) => sendResponse({ success: true, tweets }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'EXECUTE_POST') {
    executePostToX(request.contentText, request.imageUrl, request.mediaType || 'image')
      .then((result) => sendResponse({ success: true, imageError: result?.imageError || null, postedUrl: result?.postedUrl || null }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'HOME_PREPARE') {
    homePrepare(request.source)
      .then((r) => sendResponse({ success: true, ...r }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'HOME_NEXT_POST') {
    homeFindNextPost(request.skipIds, request.skipLangs)
      .then((post) => sendResponse({ success: true, post }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'HOME_REPLY_TO_POST') {
    homeReplyToPost(request.postId, request.replyText, request.likeAfterReply)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // background.js sắp điều hướng tab này sang URL khác -> dọn sạch khung soạn còn chữ
  // chưa gửi TRƯỚC, để X không kích hoạt beforeunload làm Chrome bật dialog GỐC
  // "Rời khỏi trang? Các thay đổi có thể không được lưu" (extension không tắt được dialog
  // đó, tab sẽ treo tới khi có người bấm tay). Luôn trả lời, kể cả khi không có gì để dọn.
  if (request.action === 'PREPARE_FOR_NAVIGATION') {
    prepareForNavigation()
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

});

async function scrapeKolProjectTweet(projectUsername) {
  const cleanTag = projectUsername.replace('@', '').trim().toLowerCase();
  for (let attempts = 0; attempts < 15; attempts++) {
    const articleNodes = document.querySelectorAll('article[data-testid="tweet"]');
    for (let node of articleNodes) {
      const textEl = node.querySelector('div[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText : '';
      if (text.toLowerCase().includes(`@${cleanTag}`) || text.toLowerCase().includes(cleanTag)) {
        const timeEl = node.querySelector('time');
        const timestamp = timeEl ? timeEl.getAttribute('datetime') : '';
        return { text, timestamp };
      }
    }
    window.scrollBy(0, 800);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Không tìm thấy bài viết nào tag @${cleanTag}`);
}

// Content Crypto: trả về [{ id, text, url, timestamp, author }] từ các bài đang hiện trên trang cá nhân.
// Bỏ bài ghim; bài repost vẫn trả về nhưng author = chủ bài gốc nên background.js tự lọc ra
// (chỉ giữ bài có author trùng tài khoản đang quét). Chờ bài tải xong + cuộn nhẹ nếu chưa đủ số lượng.
async function cryptoScrapeAccountTweets(limit) {
  const max = Math.max(1, Math.min(30, Number(limit) || 3));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tweets = [];
  const seen = new Set();

  for (let attempt = 0; attempt < 12 && tweets.length < max; attempt++) {
    const nodes = document.querySelectorAll('article[data-testid="tweet"]');
    for (const node of nodes) {
      if (tweets.length >= max) break;
      const isPinned = !!node.querySelector('[data-testid="pin"]') || /^\s*(Pinned|Đã ghim)/i.test(node.innerText || '');
      if (isPinned) continue;

      // Link của chính bài: <a href="/user/status/123"> bao quanh thẻ <time>.
      const timeEl = node.querySelector('time');
      const linkEl = timeEl ? timeEl.closest('a[href*="/status/"]') : node.querySelector('a[href*="/status/"]');
      const m = linkEl ? /^\/([^/]+)\/status\/(\d+)/.exec(linkEl.getAttribute('href') || '') : null;
      if (!m) continue;
      const [, author, id] = m;
      if (seen.has(id)) continue;

      const textEl = node.querySelector('div[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText.trim() : '';
      if (!text) continue; // bài chỉ có ảnh/video, không có chữ

      // Ảnh của CHÍNH bài này (không lấy ảnh trong bài trích dẫn lồng bên trong - khung đó là div[role=link]).
      // Đổi sang bản độ phân giải cao (name=large) thay vì bản thumbnail đang hiện trên timeline.
      const images = [];
      node.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((img) => {
        if (img.closest('div[role="link"]')) return;
        try {
          const u = new URL(img.currentSrc || img.src);
          if (u.hostname !== 'pbs.twimg.com' || !u.pathname.startsWith('/media/')) return;
          u.searchParams.set('name', 'large');
          if (!u.searchParams.get('format')) u.searchParams.set('format', 'jpg');
          if (!images.includes(u.toString())) images.push(u.toString());
        } catch (e) { /* bỏ qua ảnh có src lạ */ }
      });

      seen.add(id);
      tweets.push({
        id,
        text,
        url: `https://x.com/${author}/status/${id}`,
        timestamp: timeEl ? timeEl.getAttribute('datetime') : '',
        author,
        images,
      });
    }
    if (tweets.length < max) {
      window.scrollBy(0, 900);
      await wait(1500);
    }
  }
  if (tweets.length === 0) throw new Error('Không cào được bài đăng nào (trang chưa tải xong, tài khoản bị khoá/không tồn tại, hoặc X yêu cầu đăng nhập).');
  return tweets;
}

async function scrapeTop5UnpinnedTweets() {
  const tweets = [];
  for (let attempts = 0; attempts < 20 && tweets.length < 5; attempts++) {
    const articleNodes = document.querySelectorAll('article[data-testid="tweet"]');
    for (let node of articleNodes) {
      if (tweets.length >= 5) break;
      const isPinned = node.innerText.includes('Pinned') || node.innerText.includes('Đã ghim') || !!node.querySelector('[data-testid="pin"]');
      if (isPinned) continue;
      const textEl = node.querySelector('div[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText : '';
      const timeEl = node.querySelector('time');
      const timestamp = timeEl ? timeEl.getAttribute('datetime') : '';
      if (text && !tweets.some((t) => t.text === text)) tweets.push({ text, timestamp });
    }
    if (tweets.length < 5) {
      window.scrollBy(0, 800);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (tweets.length === 0) throw new Error('Không cào được bài đăng.');
  return tweets;
}

async function executePostToX(contentText, imageUrl, mediaType = 'image') {
  let editor = document.querySelector('div[data-testid="tweetTextarea_0"]') || document.querySelector('div[role="textbox"][contenteditable="true"]');

  // Khung soạn bài không tự có sẵn trên trang - trước đây code chỉ đứng chờ nó
  // xuất hiện mà không hề chủ động mở ra, nên nếu người dùng đang ở trang chủ/feed
  // (chưa mở sẵn khung soạn) thì luôn thất bại. SỬA: chủ động bấm nút "Đăng" ở
  // sidebar (data-testid="SideNav_NewTweet_Button") để mở modal soạn bài trước.
  if (!editor) {
    const composeBtn = document.querySelector('a[data-testid="SideNav_NewTweet_Button"]') || document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
    if (composeBtn) {
      composeBtn.click();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // QUAN TRỌNG: xác định đúng PHẠM VI tìm kiếm trước khi query khung soạn/nút Đăng.
  // Bấm nút "Đăng" ở sidebar (trong khi đang ở trang chủ/feed) mở ra 1 MODAL NỔI đè lên
  // trang hiện tại - nhưng trang chủ PHÍA SAU modal vẫn còn nguyên ô "Có gì mới?" (khung
  // soạn inline nằm sẵn trên đầu feed), với nút Đăng RIÊNG của chính ô đó
  // (data-testid="tweetButtonInline") - ô này luôn RỖNG/bị khoá vì không phải khung đang
  // gõ. LỖI CŨ: code query thẳng trên `document` (toàn trang), nên có thể vớ nhầm đúng
  // cái nút bị khoá của ô inline phía sau này thay vì nút "Đăng" THẬT bên trong modal,
  // khiến báo "không bấm được nút Đăng" dù nút thật vẫn bấm tay được bình thường.
  // SỬA: nếu có modal đang mở (div[aria-modal="true"] chứa sẵn khung soạn bên trong) thì
  // giới hạn MỌI truy vấn tiếp theo vào ĐÚNG bên trong modal đó; chỉ dùng toàn document
  // khi không có modal nào (trường hợp vào thẳng x.com/compose/post - trang soạn bài đầy
  // đủ, không phải overlay).
  let root = document;
  for (let i = 0; i < 15; i++) {
    const modal = document.querySelector('div[aria-modal="true"]');
    if (modal && modal.querySelector('div[data-testid="tweetTextarea_0"]')) {
      root = modal;
      break;
    }
    if (!modal && document.querySelector('div[data-testid="tweetTextarea_0"]')) break; // trang đầy đủ, không có modal
    await new Promise((r) => setTimeout(r, 300));
  }

  for (let i = 0; i < 15; i++) {
    editor = root.querySelector('div[data-testid="tweetTextarea_0"]') || root.querySelector('div[role="textbox"][contenteditable="true"]');
    if (editor) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!editor) throw new Error('Không tìm thấy khung đăng bài.');

  await typeTextRealistic(editor, contentText);

  let imageError = null;
  const isVideo = mediaType === 'video';
  const mediaList = (Array.isArray(imageUrl) ? imageUrl : [imageUrl]).filter(Boolean).slice(0, isVideo ? 1 : 4);
  for (let mi = 0; mi < mediaList.length; mi++) {
    try {
      // Tìm lại ô chọn file mỗi lần vì X có thể dựng lại sau khi nhận ảnh trước đó
      let fileInput = root.querySelector('input[data-testid="fileInput"]') || root.querySelector('input[type="file"]');
      if (!fileInput) {
        imageError = imageError || `Không tìm thấy ô đính kèm ${isVideo ? 'video' : 'ảnh'} trên giao diện đăng bài X.`;
        break;
      }
      const resp = await fetch(mediaList[mi]);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} khi tải ${isVideo ? 'video' : 'ảnh'}`);
      const blob = await resp.blob();
      const expectPrefix = isVideo ? 'video/' : 'image/';
      if (!blob.type || !blob.type.startsWith(expectPrefix)) {
        throw new Error(`Dữ liệu ${isVideo ? 'video' : 'ảnh'} không hợp lệ (${blob.type || 'không rõ loại'})`);
      }
      const fileName = isVideo ? 'video.mp4' : `image${mi + 1}.png`;
      const file = new File([blob], fileName, { type: blob.type || (isVideo ? 'video/mp4' : 'image/png') });
      const dtImg = new DataTransfer();
      dtImg.items.add(file);
      fileInput.files = dtImg.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      // Video cần thời gian X xử lý (encode/transcode) trước khi nút Đăng bật lên được -
      // chờ lâu hơn hẳn so với ảnh (chờ thật sự nằm ở vòng lặp đợi postBtn bên dưới, đây
      // chỉ là khoảng nghỉ ban đầu để X bắt đầu nhận diện file vừa chọn).
      await new Promise((r) => setTimeout(r, isVideo ? 3000 : 2000));
    } catch (e) {
      // Không chặn cả bài đăng chỉ vì lỗi ảnh/video (vẫn đăng được text), nhưng PHẢI báo
      // lỗi ra ngoài để hiện trong Nhật ký hoạt động - trước đây lỗi này bị nuốt
      // âm thầm (console.warn), khiến người dùng không biết ảnh/video đã bị rớt.
      imageError = imageError || e.message;
    }
  }

  await new Promise((r) => setTimeout(r, 1500));
  // Thử lại vài lần thay vì chỉ query 1 lần duy nhất - X có thể chưa kịp render/bật
  // nút Đăng ngay sau khi xử lý xong ảnh, nhất là khi máy/mạng chậm.
  // Luôn tìm trong ĐÚNG `root` (modal nếu có) - không còn fallback ra toàn document,
  // để không bao giờ vớ nhầm nút tweetButtonInline của ô soạn khác nằm ngoài modal.
  let postBtn = null;
  const postBtnAttempts = isVideo ? 60 : 10; // video: chờ tới ~60s cho X xử lý xong trước khi nút Đăng bật lên
  for (let i = 0; i < postBtnAttempts; i++) {
    postBtn = root.querySelector('button[data-testid="tweetButtonInline"]') || root.querySelector('button[data-testid="tweetButton"]');
    const isDisabled = postBtn && (postBtn.disabled || postBtn.getAttribute('aria-disabled') === 'true');
    if (postBtn && !isDisabled) break;
    postBtn = null;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Chụp trước danh sách link /status/ đang có trên trang - dùng làm phương án dự phòng để nhận ra
  // link bài MỚI (xuất hiện sau khi bấm Đăng) nếu không đọc được từ thông báo (xem bên dưới).
  const statusHrefsBefore = new Set(Array.from(document.querySelectorAll('a[href*="/status/"]')).map((a) => a.getAttribute('href') || ''));
  if (postBtn) {
    postBtn.click();
  } else {
    // Nguyên nhân phổ biến nhất khiến nút Đăng bị khoá cứng (không bao giờ hết disabled):
    // nội dung dài hơn giới hạn ký tự thực tế X cho phép trên tài khoản này (thường 280
    // ký tự/tweet với tài khoản thường, dài hơn nếu có X Premium/Premium+). Code hiện chỉ
    // gõ toàn bộ nội dung vào 1 khung tweet DUY NHẤT - chưa có logic tách thành nhiều
    // tweet nối tiếp (thread thật sự), nên nếu Độ dài cài trong Setting Tạo Content vượt
    // quá giới hạn 1 tweet của tài khoản, nút Đăng sẽ luôn bị khoá.
    throw new Error('Không bấm được nút Đăng bài (nút đang bị khoá hoặc không tìm thấy đúng nút trong khung soạn đang mở). Nếu tài khoản không có X Premium, kiểm tra lại Độ dài trong Setting Tạo Content có đang vượt quá 280 ký tự/tweet không.');
  }

  // Sau khi bấm Đăng, X hiện 1 toast xác nhận ("Đã gửi bài viết của bạn"/"Your post was
  // sent") có kèm link "Xem"/"View" trỏ thẳng tới bài vừa đăng - đây là cách NHANH NHẤT
  // để lấy được link bài mới mà không cần mở lại trang cá nhân rồi đi tìm bài mới nhất
  // (dễ nhặt nhầm bài ghim/bài cũ).
  // Toast có thể chưa kịp hiện ngay lúc này -> thử lại vài lần trong ~6 giây.
  // KHÔNG dựa vào chữ hiển thị của thông báo ("Your post was sent"/"View" hay bản Tiếng Việt "Đã gửi bài
  // viết của bạn"/"Xem"...) vì chữ đổi theo ngôn ngữ tài khoản X. Chỉ dựa vào cấu trúc không đổi theo ngôn ngữ:
  //  (1) link /status/ nằm TRONG khung thông báo (data-testid="toast" / role="alert"), hoặc
  //  (2) dự phòng: link /status/ của CHÍNH MÌNH mới xuất hiện sau khi bấm Đăng (không có trong danh sách chụp trước).
  // Trước đây lấy link /status/ ĐẦU TIÊN trên cả trang nên có thể nhặt nhầm bài khác đang hiển thị.
  const parseStatusHref = (href) => {
    const m = (href || '').match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    return m ? { user: m[1], id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` } : null;
  };
  const findPostedUrl = () => {
    const toasts = document.querySelectorAll('[data-testid="toast"], [role="alert"]');
    for (const t of toasts) {
      for (const a of t.querySelectorAll('a[href*="/status/"]')) {
        const p = parseStatusHref(a.getAttribute('href'));
        if (p) return p.url;
      }
    }
    const self = homeGetSelfUsername();
    if (self) {
      for (const a of document.querySelectorAll('a[href*="/status/"]')) {
        const href = a.getAttribute('href') || '';
        if (statusHrefsBefore.has(href)) continue;
        const p = parseStatusHref(href);
        if (p && p.user.toLowerCase() === self) return p.url;
      }
    }
    return null;
  };

  let postedUrl = null;
  for (let i = 0; i < 16; i++) {
    postedUrl = findPostedUrl();
    if (postedUrl) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Không tìm được -> KHÔNG chặn lỗi cả bài đăng, chỉ trả về postedUrl = null để nơi gọi tự xử lý
  // (báo người dùng tự dán link tay).

  return { imageError, postedUrl };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Gõ như bàn phím thật (từng ký tự) thay vì dán 1 cục qua ClipboardEvent -
// 1 số ô soạn của X xử lý sự kiện paste khác với gõ tay, gõ từng ký tự qua
// execCommand('insertText') + input event mô phỏng đúng hành vi gõ hơn.
function ensureEditorFocused(editor) {
  if (!editor.isConnected) {
    throw new Error('Khung soạn nội dung đã bị đóng giữa chừng khi đang gõ.');
  }
  const active = document.activeElement;
  if (active === editor || editor.contains(active)) return;
  editor.focus();
  const after = document.activeElement;
  if (!(after === editor || editor.contains(after))) {
    throw new Error('Khung soạn mất focus khi đang gõ - dừng lại để không kích hoạt nhầm phím tắt của X.');
  }
}

async function typeTextRealistic(editor, text) {
  // Tốc độ gõ đọc từ Cài Đặt do người dùng chỉnh (mặc định 30-80ms/ký tự nếu chưa cài đặt).
  let minMs = 30, maxMs = 80;
  try {
    const store = await chrome.storage.local.get(['typingSpeedMin', 'typingSpeedMax']);
    minMs = parseInt(store.typingSpeedMin, 10) || minMs;
    maxMs = parseInt(store.typingSpeedMax, 10) || maxMs;
    if (maxMs < minMs) maxMs = minMs;
  } catch (e) { /* giữ mặc định nếu đọc storage lỗi */ }

  editor.focus();
  ensureEditorFocused(editor);
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  await wait(150);

  // Gõ phím THẬT cho từng ký tự: bắn đủ keydown/keypress/keyup như bàn phím thật, xen
  // giữa là lệnh chèn ký tự tương ứng. Xuống dòng dùng đúng tổ hợp Shift+Enter (keydown/
  // keyup Enter kèm shiftKey:true) + insertLineBreak - đúng phím người dùng thật sẽ bấm
  // để xuống dòng trong khung soạn bài của X.
  for (const ch of text) {
    // Khung soạn bị X đóng/dựng lại giữa chừng (hoặc mất focus) -> DỪNG NGAY với lỗi rõ ràng,
    // không gõ tiếp "vào khoảng không": ký tự lọt ra ngoài khung soạn có thể kích hoạt phím tắt
    // của X (ví dụ gõ "g" rồi "h" = về Home).
    ensureEditorFocused(editor);
    if (ch === '\n') {
      const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, bubbles: true };
      editor.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      editor.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
      document.execCommand('insertLineBreak', false, null);
      editor.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    } else {
      const keyOpts = { key: ch, bubbles: true };
      editor.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
      editor.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
      document.execCommand('insertText', false, ch);
      editor.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(minMs + Math.random() * (maxMs - minMs));
  }
}

// Cuộn cho tới khi hết danh sách. LỖI CŨ: "đã chạm đáy" được suy ra từ hình học
// chung chung (div[style*="overflow"] bất kỳ trên trang) - nhiều khung nhỏ không
// liên quan gì tới danh sách follower/following (sidebar, popup...) cũng khớp
// selector này và tình cờ "hết cuộn được" ngay từ đầu, khiến hàm kết luận sai là
// đã chạm đáy trong khi danh sách chính chưa cuộn được bao nhiêu.
// Sửa: chỉ tin vào 2 tín hiệu thật sự gắn với DANH SÁCH ĐANG XỬ LÝ - (1) còn xuất
// hiện user cell MỚI hay không (đo bằng getUserCells(), không suy luận qua chiều cao
// trang) và (2) vị trí cuộn của cửa sổ có còn nhích lên hay không. Chỉ kết luận đã
// chạm đáy thật sự khi CẢ HAI cùng đứng yên liên tiếp nhiều vòng.
async function scrollToBottomFully(maxRounds = 5000) {
  // LỖI CŨ: giới hạn 200 vòng x 2200px nên danh sách rất dài chưa tải hết đã bị coi là xong; ngoài ra
  // đếm số user đang có trong DOM để biết "còn tải thêm không" là sai vì X chỉ giữ ~vài chục user trong DOM
  // (danh sách ảo hoá), số đó gần như không tăng. SỬA: theo dõi CHIỀU CAO CUỘN THẬT của trang (tăng
  // dần khi X tải thêm) và vị trí cuộn - chỉ dừng khi đã chạm đáy VÀ chiều cao không tăng nữa trong nhiều vòng liên tiếp.
  let lastMax = -1;
  let noGrowthRounds = 0;

  for (let i = 0; i < maxRounds; i++) {
    scrollFeed(2200);
    await wait(700);

    const { max } = getScrollMetrics();
    if (max > lastMax + 2) {
      lastMax = max;
      noGrowthRounds = 0;
    } else {
      noGrowthRounds++;
    }

    // X có thể vẫn đang tải thêm ngay sau khi tưởng đã hết - đòi hỏi đứng yên đủ lâu (8 vòng ~ 6 giây).
    if (noGrowthRounds >= 8 && isScrollAtBottom()) break;
  }
}

async function scrollToTop() {
  window.scrollTo(0, 0);
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  await wait(800);
}

// Đọc số theo cả 2 kiểu định dạng: có hậu tố K/M ("1.2K", "3,5M"...) và số nguyên
// đầy đủ có dấu phân cách hàng nghìn kiểu Việt Nam ("1.062", "1.225" - dùng dấu CHẤM
// làm phân cách hàng nghìn). LỖI CŨ: code trước đây coi mọi dấu chấm là dấu thập phân
// kiểu Mỹ (bỏ qua, không xử lý gì) nên parseInt("1.062") chỉ đọc ra "1" - sai hoàn
// toàn - đây là lý do việc so sánh tỉ lệ Following/Follower luôn dùng nhầm số liệu.
function parseNumber(str) {
  if (!str) return 0;
  let clean = str.trim().toUpperCase();

  if (clean.endsWith('K') || clean.endsWith('M')) {
    const isM = clean.endsWith('M');
    let numPart = clean.slice(0, -1);
    // Chỉ dấu phân cách CUỐI CÙNG (nếu có) được coi là dấu thập phân, các dấu còn lại
    // (nếu có) là phân cách hàng nghìn và bị loại bỏ.
    const lastSep = Math.max(numPart.lastIndexOf('.'), numPart.lastIndexOf(','));
    if (lastSep !== -1) {
      numPart = numPart.slice(0, lastSep).replace(/[.,]/g, '') + '.' + numPart.slice(lastSep + 1);
    }
    const val = parseFloat(numPart) || 0;
    return Math.round(val * (isM ? 1000000 : 1000));
  }

  // Không có hậu tố K/M -> đây luôn là số nguyên đầy đủ, mọi dấu . hoặc , ở giữa
  // đều là phân cách hàng nghìn (không phải thập phân).
  clean = clean.replace(/[.,]/g, '');
  return parseInt(clean, 10) || 0;
}

// X đôi khi không cuộn được bằng window.scrollBy (trang dùng 1 container cuộn
// nội bộ thay vì cuộn cả cửa sổ) -> nếu window không nhúc nhích, thử cuộn
// container cha gần nhất có thể cuộn được. Đây nhiều khả năng là lý do trước đây
// Follow/Unfollow chỉ xử lý được đúng 1 lượt user rồi dừng (không tải thêm được
// user mới vì lệnh cuộn không có tác dụng gì).
function scrollFeed(amount) {
  const beforeY = window.scrollY;
  window.scrollBy(0, amount);
  if (Math.abs(window.scrollY - beforeY) > 2) return;

  const candidates = document.querySelectorAll('div[data-testid="primaryColumn"], main, div[style*="overflow"]');
  for (const el of candidates) {
    const beforeTop = el.scrollTop;
    el.scrollTop += amount;
    if (Math.abs(el.scrollTop - beforeTop) > 2) return;
  }
  document.scrollingElement.scrollTop += amount;
}

// Đọc vị trí cuộn THẬT của đúng phần tử đang thực sự cuộn (window, hoặc 1 container
// nội bộ nếu window không cuộn được - xem lý do trong scrollFeed() ở trên). Dùng để
// biết CHẮC CHẮN thanh cuộn của trang đã chạm đáy thật hay chưa, thay vì chỉ suy đoán
// qua việc "có thấy user mới hay không" (suy đoán này sai khi trang tải chậm - xem
// executeUnfollowLogic bên dưới).
function getScrollMetrics() {
  const winMax = document.documentElement.scrollHeight - window.innerHeight;
  if (winMax > 2) return { top: window.scrollY, max: winMax };

  const candidates = document.querySelectorAll('div[data-testid="primaryColumn"], main, div[style*="overflow"]');
  for (const el of candidates) {
    const max = el.scrollHeight - el.clientHeight;
    if (max > 2) return { top: el.scrollTop, max };
  }
  return { top: 0, max: 0 };
}

// true khi thanh cuộn (window hoặc container nội bộ, tuỳ cái nào đang thực sự cuộn)
// ĐÃ Ở ĐÚNG VỊ TRÍ ĐÁY - không còn cuộn thêm được nữa tại thời điểm gọi. Đây chỉ là
// trạng thái TỨC THỜI (trang có thể vẫn đang tải thêm dữ liệu để nới thêm chiều cao
// ngay sau đó) - nơi gọi hàm này cần tự đòi hỏi trạng thái này lặp lại ổn định qua
// vài vòng liên tiếp mới được kết luận là "hết thật".
function isScrollAtBottom() {
  const { top, max } = getScrollMetrics();
  return max <= 2 || top >= max - 2;
}

// Đối xứng với isScrollAtBottom() - dùng cho direction 'bottom_up': hướng này đã cuộn
// hết xuống đáy để preload TOÀN BỘ danh sách TRƯỚC KHI vào vòng lặp xử lý (xem
// scrollToBottomFully() được gọi trước for-loop trong executeUnfollowLogic), nên trong
// lúc cuộn NGƯỢC LÊN không còn nguy cơ "trang đang tải thêm" nữa - điểm kết thúc thật
// sự ở đây là đỉnh (top), không phải đáy.
function isScrollAtTop() {
  const { top } = getScrollMetrics();
  return top <= 2;
}

// Lấy danh sách "khung user" trong trang follower/following. Ưu tiên
// data-testid="UserCell" (ổn định nhất). Nếu X đổi tên hoặc cấu trúc trang thay đổi
// khiến không tìm thấy khung nào theo cách đó, dò ngược từ chính nút Follow/Unfollow
// (data-testid$="-follow"/"-unfollow" - đã xác nhận vẫn đúng trên giao diện hiện tại)
// lên vài cấp cha để tìm khung chứa cả link user + nút bấm.
// Path SVG chính xác của icon tích xanh (không đổi theo ngôn ngữ/testid, xác nhận bằng
// HTML thật) - dùng làm lớp kiểm tra dự phòng nếu data-testid/aria-label bị đổi tên.
const VERIFIED_ICON_PATH_PREFIX = 'M20.396 11c-.018-.646';

function isCellVerified(cell) {
  if (cell.querySelector('svg[data-testid="icon-verified"]')) return true;
  if (cell.querySelector('[aria-label="Verified account"]')) return true;
  const paths = cell.querySelectorAll('svg path');
  for (const p of paths) {
    const d = p.getAttribute('d') || '';
    if (d.startsWith(VERIFIED_ICON_PATH_PREFIX)) return true;
  }
  return false;
}

// Quét toàn bộ comment - có cuộn để lấy hết (trước đây chỉ đọc đúng những gì
// render sẵn trên màn hình đầu tiên, bài có nhiều comment hơn màn hình sẽ bị thiếu).
// Dùng getTopLevelArticles() để không đếm nhầm quote-tweet lồng bên trong là 1 comment.
// Loại trừ đúng BÀI GỐC theo status ID trong URL (không dựa vào vị trí index / so nội
// dung index 0 - trước đây có trường hợp bài gốc lọt vào danh sách comment thành "comment 1"
// và gây lỗi vì bài gốc không có cấu trúc reply giống comment thường).
function normalizeText(t) {
  return (t || '').replace(/\s+/g, ' ').trim();
}

// Chỉ lấy article Ở CẤP NGOÀI CÙNG. querySelectorAll('article[data-testid="tweet"]')
// bắt luôn cả những <article> lồng bên trong (ví dụ tweet được trích dẫn/quote bên
// trong 1 comment) - những article lồng này KHÔNG có thanh hành động (reply/like...)
// riêng, nên nếu chẳng may khớp nhầm vào 1 article lồng, tìm nút reply sẽ luôn thất bại.
function getTopLevelArticles() {
  const all = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  return all.filter((a) => !all.some((other) => other !== a && other.contains(a)));
}

// Đóng khung soạn reply CHỈ khi thật sự cần. LỖI CŨ: sau khi gửi reply, X TỰ đóng khung soạn
// (thực chất là lùi lịch sử trình duyệt về trang bài đăng). Code cũ chỉ chờ 1,2 giây rồi hễ còn
// thấy phần tử dialog (đang mờ dần) là bấm nút Đóng/Escape LẦN NỮA -> X lùi thêm 1 bước nữa; vì
// tab được mở thẳng vào bài đăng nên không còn trang nào phía trước để lùi, X đưa thẳng về HOME.
// Đây là lý do "reply được vài comment rồi bị về Home" (chỉ xảy ra khi X đóng hơi chậm).
// Nay chỉ bấm đóng khi địa chỉ trang vẫn đang là màn hình soạn (/compose...).
async function closeComposerModalSafely(modal) {
  if (!location.pathname.startsWith('/compose')) return false;
  const closeBtn = modal.querySelector('[data-testid="app-bar-close"]') || modal.querySelector('[aria-label="Close"]') || modal.querySelector('[aria-label="Đóng"]');
  if (!closeBtn) return false;
  closeBtn.click();
  await wait(600);
  // Đóng khi còn chữ chưa gửi -> X hỏi "Lưu bài đăng?": chọn bỏ đi.
  const discardBtn = document.querySelector('button[data-testid="confirmationSheetConfirm"]');
  if (discardBtn) {
    discardBtn.click();
    await wait(500);
  }
  return true;
}

// Dọn khung soạn trước khi background.js điều hướng tab đi nơi khác (xem
// PREPARE_FOR_NAVIGATION ở đầu file). Khác closeComposerModalSafely(): KHÔNG giới hạn ở
// /compose - khung soạn reply mở ngay trên trang bài đăng cũng phải được đóng + bấm "Bỏ"
// ở hộp thoại "Lưu bài đăng?", vì chính phần chữ chưa gửi trong đó mới là thứ khiến X bật
// beforeunload lúc bị ép điều hướng. Nuốt mọi lỗi: đây là bước dọn dẹp best-effort, không
// được phép làm hỏng lượt điều hướng đang chờ nó.
async function prepareForNavigation() {
  try {
    const modal = document.querySelector('div[aria-modal="true"]');
    if (modal && modal.querySelector('div[data-testid="tweetTextarea_0"]')) {
      const closeBtn = modal.querySelector('[data-testid="app-bar-close"]')
        || modal.querySelector('[aria-label="Close"]')
        || modal.querySelector('[aria-label="Đóng"]');
      if (closeBtn) {
        closeBtn.click();
        await wait(600);
      }
    }
    // Hộp thoại "Lưu bài đăng?" của X (trong DOM, không phải dialog gốc trình duyệt) -> chọn Bỏ.
    for (let i = 0; i < 3; i++) {
      const discardBtn = document.querySelector('button[data-testid="confirmationSheetConfirm"]');
      if (!discardBtn) break;
      discardBtn.click();
      await wait(400);
    }
  } catch (e) { /* best-effort */ }
  return true;
}

// Dọn khung soạn còn sót lại từ lần reply lỗi trước (nếu có) để không gõ nhầm vào khung cũ.
async function dismissLeftoverComposer() {
  const leftover = document.querySelector('div[aria-modal="true"]');
  if (leftover && leftover.querySelector('div[data-testid="tweetTextarea_0"]')) {
    await closeComposerModalSafely(leftover);
    await wait(500);
  }
}

// Dùng chung cho Reply Comment và Tương tác Home: từ 1 article (bài/comment) đã tìm được ->
// cuộn tới, bấm Reply, đợi ĐÚNG khung soạn (modal) mở ra, gõ nội dung, gửi, rồi chờ X tự đóng khung.
async function replyViaComposerModal(target, replyText) {
  // Luôn cuộn vào giữa màn hình và chờ 1 nhịp trước khi tìm nút reply -
  // X ảo hoá danh sách nên 1 article có thể tồn tại trong DOM nhưng chưa
  // mount đầy đủ thanh hành động (reply/like/retweet) nếu chưa từng lọt vào viewport.
  target.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 500));

  let replyIcon = target.querySelector('[data-testid="reply"]');
  for (let i = 0; i < 6 && !replyIcon; i++) {
    await new Promise((r) => setTimeout(r, 400));
    replyIcon = target.querySelector('[data-testid="reply"]');
  }
  if (!replyIcon) {
    const ids = new Set();
    target.querySelectorAll('[data-testid]').forEach((n) => ids.add(n.getAttribute('data-testid')));
    throw new Error(`Không tìm thấy nút reply trên bài này. (data-testid có trong bài: ${Array.from(ids).join(', ') || '(không có)'})`);
  }
  replyIcon.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 300));
  replyIcon.click();

  // QUAN TRỌNG: trang chi tiết bài viết LUÔN có sẵn 1 khung "Đăng phản hồi" ngay dưới
  // bài gốc, hiển thị thường trực (không cần bấm gì) - khung đó dùng CHUNG
  // data-testid="tweetTextarea_0" với khung soạn hiện ra bên trong modal khi bấm reply
  // vào 1 comment cụ thể. LỖI CŨ: sau khi bấm reply, ở vòng lặp đầu tiên modal riêng
  // của comment CHƯA KỊP MỞ (modal = null) nên `||` rơi xuống
  // `document.querySelector('div[data-testid="tweetTextarea_0"]')' không giới hạn phạm
  // vi - vớ trúng NGAY khung "Đăng phản hồi" của bài gốc (luôn có sẵn từ trước, gần như
  // khớp tức thì ở i=0), khiến nội dung bị gõ nhầm thành 1 reply MỚI vào thẳng bài gốc
  // (kèm nhắc tên @username trong câu) thay vì reply đúng vào comment đó.
  // SỬA: bắt buộc phải có MODAL THẬT SỰ mở ra (div[aria-modal="true"] chứa sẵn khung
  // soạn bên trong) mới được lấy khung soạn - không còn fallback ra ngoài document nữa,
  // dừng hẳn với lỗi rõ ràng nếu không thấy modal thay vì âm thầm dùng nhầm khung khác.
  let modal = null;
  for (let i = 0; i < 20; i++) {
    const m = document.querySelector('div[aria-modal="true"]');
    if (m && m.querySelector('div[data-testid="tweetTextarea_0"]')) {
      modal = m;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!modal) {
    throw new Error('Không mở được khung reply riêng cho bài này (không thấy modal xuất hiện) - có thể đã bấm nhầm nút hoặc X đổi giao diện.');
  }
  const editor = modal.querySelector('div[data-testid="tweetTextarea_0"]');

  await typeTextRealistic(editor, replyText);

  await new Promise((r) => setTimeout(r, 1000));

  // Giới hạn tìm nút Reply TRONG ĐÚNG modal đang mở - không còn fallback ra document
  // (cùng lý do như trên: khung/nút của bài gốc luôn có sẵn, dễ bấm nhầm).
  let replyBtn = null;
  for (let i = 0; i < 10; i++) {
    replyBtn = modal.querySelector('button[data-testid="tweetButtonInline"]') || modal.querySelector('button[data-testid="tweetButton"]');
    const isDisabled = replyBtn && (replyBtn.disabled || replyBtn.getAttribute('aria-disabled') === 'true');
    if (replyBtn && !isDisabled) break;
    replyBtn = null;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!replyBtn) throw new Error('Không thể bấm nút reply (nút đang bị khoá).');
  replyBtn.click();

  // Chờ X TỰ đóng khung soạn sau khi gửi (tối đa ~10 giây) - KHÔNG bấm đóng thêm lần nữa
  // (xem chú thích ở closeComposerModalSafely). Khung soạn biến mất = reply đã gửi xong.
  let sent = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!modal.isConnected || !modal.querySelector('div[data-testid="tweetTextarea_0"]')) {
      sent = true;
      break;
    }
  }
  if (!sent) {
    await closeComposerModalSafely(modal);
    throw new Error('Reply chưa gửi được: khung soạn vẫn còn mở sau 10 giây (X có thể đang giới hạn tốc độ hoặc báo lỗi).');
  }
  // Nghỉ 1 nhịp để X dựng lại danh sách trước lần tìm/reply kế tiếp.
  await new Promise((r) => setTimeout(r, 800));
}

// ============== TƯƠNG TÁC HOME (reply các bài trên timeline Home thay vì theo link) ==============
function homeGetSelfUsername() {
  const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const href = a ? (a.getAttribute('href') || '') : '';
  return href.replace(/^\//, '').split('/')[0].toLowerCase();
}

// Đọc thông tin 1 bài trên timeline từ CHÍNH thời gian đăng (link .../status/ID) của bài đó - không
// dựa vào vị trí/index vì X ảo hoá danh sách. Quote/repost vẫn lấy đúng bài đang hiển thị chính.
function homeReadArticle(article) {
  const timeEl = article.querySelector('a[href*="/status/"] time');
  const link = timeEl ? timeEl.closest('a') : null;
  const href = link ? (link.getAttribute('href') || '') : '';
  const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
  if (!m) return null;
  const textEl = article.querySelector('div[data-testid="tweetText"]');
  return {
    id: m[2],
    username: m[1],
    text: normalizeText(textEl ? textEl.innerText : ''),
    lang: textEl ? (textEl.getAttribute('lang') || '') : '',
    isAd: !!article.querySelector('[data-testid="placementTracking"]'),
    hasReplyBtn: !!article.querySelector('[data-testid="reply"]'),
    // Chỉ Tương tác Home mới lọc theo cờ này (xem homeFindNextPost) - dùng lại đúng cách dò
    // icon tích xanh đã có sẵn cho Follow/Unfollow (isCellVerified) để đồng nhất, không phải
    // viết thêm 1 cách dò khác.
    isVerified: isCellVerified(article),
  };
}

// Xác định ngôn ngữ của 1 bài: X gắn sẵn thuộc tính lang (ja, ko, en, vi...) lên phần chữ của bài nên ưu tiên
// dùng nó (chính xác nhất). Bài không có lang / lang="und" (không xác định) thì đoán theo bảng chữ viết
// (Nhật/Hàn/Trung/Thái/Ả Rập/Kirin/Devanagari...). Ngôn ngữ dùng chữ Latin (Anh, Pháp, Tây Ban Nha...) không
// đoán được từ chữ viết nên chỉ dựa vào thuộc tính lang.
function homeDetectLangCodes(text, langAttr) {
  const codes = new Set();
  const lang = String(langAttr || '').toLowerCase();
  if (lang && lang !== 'und') {
    codes.add(lang);
    codes.add(lang.split('-')[0]);
    return codes;
  }
  const t = text || '';
  const hasKana = /[\u3040-\u30ff]/.test(t);
  const hasHangul = /[\uac00-\ud7af\u1100-\u11ff]/.test(t);
  const hasHan = /[\u4e00-\u9fff]/.test(t);
  if (hasKana) codes.add('ja');
  if (hasHangul) codes.add('ko');
  if (hasHan && !hasKana && !hasHangul) codes.add('zh');
  if (/[\u0e00-\u0e7f]/.test(t)) codes.add('th');
  if (/[\u0600-\u06ff]/.test(t)) { codes.add('ar'); codes.add('fa'); codes.add('ur'); }
  if (/[\u0400-\u04ff]/.test(t)) { codes.add('ru'); codes.add('uk'); }
  if (/[\u0900-\u097f]/.test(t)) codes.add('hi');
  if (/[\u0590-\u05ff]/.test(t)) { codes.add('he'); codes.add('iw'); }
  if (/[\u0980-\u09ff]/.test(t)) codes.add('bn');
  return codes;
}

function homeFindArticleById(id) {
  return getTopLevelArticles().find((a) => {
    const info = homeReadArticle(a);
    return info && info.id === id;
  }) || null;
}

async function homePrepare(source) {
  for (let i = 0; i < 30 && getTopLevelArticles().length === 0; i++) await wait(500);
  if (getTopLevelArticles().length === 0) {
    throw new Error('Timeline Home chưa tải được bài nào (đã đăng nhập X trên trình duyệt này chưa?).');
  }

  // Chọn đúng dòng thời gian: tab đầu = "Dành cho bạn", tab thứ 2 = "Đang theo dõi" (chọn theo THỨ TỰ nên
  // không phụ thuộc ngôn ngữ giao diện X).
  const tablist = document.querySelector('[data-testid="primaryColumn"] [role="tablist"]');
  const tabs = tablist ? Array.from(tablist.querySelectorAll('[role="tab"]')) : [];
  if (tabs.length >= 2) {
    const want = tabs[source === 'following' ? 1 : 0];
    if (want.getAttribute('aria-selected') !== 'true') {
      want.click();
      await wait(2500);
      for (let i = 0; i < 20 && getTopLevelArticles().length === 0; i++) await wait(500);
    }
  }
  await scrollToTop();
  return { selfUsername: homeGetSelfUsername() };
}

// Tìm bài kế tiếp đủ điều kiện: chưa xử lý, không phải quảng cáo, không phải bài của chính
// mình, có nội dung chữ, có nút Reply, VÀ tài khoản đăng bài phải có tích xanh (isVerified).
// Không có bài nào trong khung nhìn thì cuộn xuống để X tải thêm.
async function homeFindNextPost(skipIds, skipLangs) {
  const skip = new Set(skipIds || []);
  const blockedLangs = (skipLangs || []).map((x) => String(x).toLowerCase());
  const self = homeGetSelfUsername();
  let lastY = -1;
  let stuck = 0;

  for (let round = 0; round < 25; round++) {
    const articles = getTopLevelArticles().slice().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    for (const article of articles) {
      const info = homeReadArticle(article);
      if (!info || skip.has(info.id)) continue;
      if (info.isAd || !info.hasReplyBtn || !info.text) continue;
      if (!info.isVerified) continue; // chỉ reply tài khoản tích xanh
      if (self && info.username.toLowerCase() === self) continue;
      if (blockedLangs.length > 0) {
        const codes = homeDetectLangCodes(info.text, info.lang);
        if (blockedLangs.some((l) => codes.has(l))) continue; // ngôn ngữ người dùng muốn bỏ qua
      }
      return { id: info.id, username: info.username, text: info.text, lang: info.lang || '', url: `https://x.com/${info.username}/status/${info.id}` };
    }

    scrollFeed(800);
    await wait(1500);
    if (Math.abs(window.scrollY - lastY) < 2) {
      stuck++;
      if (stuck >= 4) break;
    } else {
      stuck = 0;
    }
    lastY = window.scrollY;
  }
  return null;
}

async function homeLocateArticle(id) {
  let target = homeFindArticleById(id);
  if (target) return target;
  // Bài vừa được đọc nên thường còn rất gần vị trí hiện tại: thử cuộn lên rồi cuộn xuống.
  for (let i = 0; i < 10 && !target; i++) {
    scrollFeed(-500);
    await wait(600);
    target = homeFindArticleById(id);
  }
  for (let i = 0; i < 25 && !target; i++) {
    scrollFeed(500);
    await wait(600);
    target = homeFindArticleById(id);
  }
  return target;
}

async function homeReplyToPost(postId, replyText, likeAfterReply) {
  if (!/^\/home/.test(location.pathname)) {
    throw new Error(`Trang X không còn ở Home (đang ở ${location.pathname}).`);
  }
  await dismissLeftoverComposer();

  const target = await homeLocateArticle(postId);
  if (!target) {
    throw new Error('Không tìm lại được bài trên timeline (X có thể đã tải lại timeline làm bài trôi mất).');
  }

  await replyViaComposerModal(target, replyText);

  if (likeAfterReply) {
    await wait(800);
    const article = homeFindArticleById(postId) || target;
    const likeBtn = article.querySelector('[data-testid="like"]'); // đã like rồi thì testid là "unlike" -> bỏ qua
    if (likeBtn) {
      article.scrollIntoView({ block: 'center' });
      await wait(400);
      likeBtn.click();
      await wait(500);
    }
  }
}

// ============================================================================
// ============================================================================
// NÚT "REPLY AI" TRÊN MỌI BÀI Ở X.COM - chèn vào thanh hành động của MỖI bài đăng, ngay khoảng trống giữa
// nút Views (biểu đồ) và nút Bookmark. Luôn hiển thị trên mọi trang x.com (Home, profile, trang bài...),
// không cần đang chạy tính năng nào và không cần mở panel tiện ích.
// Bấm vào: đọc bài (kèm bài gốc nếu đây là bình luận), nhờ background soạn reply bằng AI theo cài đặt Chéo
// Link đã lưu (ngôn ngữ / giọng văn / số từ / phong cách riêng), rồi tự gửi reply đúng vào bài đó.
// - Nút nằm trong Shadow DOM (closed): CSS của X không làm méo nút, còn các hàm quét DOM của tiện ích
//   (Chéo Link, Tương tác Home...) và script của X không nhìn thấy nút -> không ảnh hưởng gì tới chúng.
// - X (React) hay vẽ lại bài khi cuộn/tải thêm làm nút bị mất -> MutationObserver chèn lại ngay, nên nút
//   luôn hiển thị trên mọi bài.
// ============================================================================
(function initReplyAiButton() {
  if (window.top !== window) return; // chỉ ở khung chính, không chèn trong iframe

  const HOST_ATTR = 'data-ndan-reply-ai';
  const IDLE_LABEL = 'Reply AI';
  const IDLE_TITLE = 'Soạn reply bằng AI theo nội dung bài rồi tự gửi';
  const STYLE = `
    :host { all: initial; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
    button {
      all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
      cursor: pointer; padding: 4px 10px; margin: 0 4px; border-radius: 9999px; white-space: nowrap;
      font: 700 12px/1 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      --fg: 29,155,240;
      color: rgb(var(--fg)); background: rgba(var(--fg), .10); border: 1px solid rgba(var(--fg), .55);
      transition: opacity .15s ease;
    }
    button:hover { opacity: .8; }
    button:focus-visible { outline: 2px solid rgb(29,155,240); outline-offset: 2px; }
    button[data-kind="busy"]  { --fg: 255,173,31; cursor: progress; }
    button[data-kind="ok"]    { --fg: 0,186,124; }
    button[data-kind="error"] { --fg: 244,33,46; }
  `;

  let observer = null;
  let scanQueued = false;
  let working = false;              // mỗi lúc chỉ xử lý 1 bài (tránh mở nhiều khung reply chồng nhau)
  let activeState = null;           // { postId, label, kind, title } - giữ chữ trên nút kể cả khi X vẽ lại bài
  const buttons = new Set();        // { host, btn } của mọi nút đang có trên trang

  function sendMessageP(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || 'Lỗi kết nối tiện ích.'));
          resolve(res);
        });
      } catch (e) { reject(e); }
    });
  }

  // Thanh hành động của bài: khối role="group" có nút reply. Bài trích dẫn (quote) không có thanh riêng.
  function findActionBar(article) {
    const groups = article.querySelectorAll('div[role="group"]');
    for (const g of groups) if (g.querySelector('[data-testid="reply"]')) return g;
    return null;
  }

  function currentPostId(article) {
    const info = homeReadArticle(article);
    return info ? info.id : '';
  }

  // Đổi chữ/màu của nút ở đúng bài đang xử lý; resetMs > 0 thì tự về "Reply AI" sau ngần đó ms.
  function setLabel(postId, label, kind, resetMs, title) {
    const mine = { postId, label, kind, title: title || '' };
    activeState = mine;
    paintState();
    if (resetMs > 0) {
      setTimeout(() => {
        if (activeState !== mine) return;
        activeState = null;
        paintState();
      }, resetMs);
    }
  }

  function paintState() {
    buttons.forEach((rec) => {
      if (!rec.host.isConnected) { buttons.delete(rec); return; } // X đã gỡ bài này khỏi trang
      const isActive = !!activeState && rec.host.getAttribute('data-post-id') === activeState.postId;
      rec.btn.textContent = isActive ? activeState.label : IDLE_LABEL;
      rec.btn.title = isActive && activeState.title ? activeState.title : IDLE_TITLE;
      rec.btn.dataset.kind = isActive ? activeState.kind : 'idle';
    });
  }

  // Bình luận nằm dưới 1 bài gốc (đang mở trang /status/ID) -> lấy thêm bài gốc làm ngữ cảnh cho AI.
  function getParentContext(info) {
    const m = location.pathname.match(/\/status\/(\d+)/);
    if (!m || m[1] === info.id) return null;
    const mainArticle = homeFindArticleById(m[1]);
    const mainInfo = mainArticle ? homeReadArticle(mainArticle) : null;
    if (!mainInfo || !mainInfo.text) return null;
    return { username: mainInfo.username, text: mainInfo.text, lang: mainInfo.lang };
  }

  async function onClickReplyAi(article) {
    if (working) return;
    const info = homeReadArticle(article);
    if (!info) return;
    if (!info.text) {
      setLabel(info.id, 'Bài không có chữ', 'error', 3000, 'Bài này không có nội dung chữ để AI đọc.');
      return;
    }

    working = true;
    try {
      setLabel(info.id, 'Đang soạn...', 'busy', 0);
      const parent = getParentContext(info);
      let gen;
      try {
        gen = await sendMessageP({
          action: 'REPLY_AI_GENERATE',
          username: info.username, text: info.text, lang: info.lang,
          parentUsername: parent ? parent.username : '', parentText: parent ? parent.text : '', parentLang: parent ? parent.lang : '',
        });
      } catch (e) {
        throw new Error('Không kết nối được tiện ích (có thể vừa được cập nhật/tải lại) - hãy tải lại trang X (F5) rồi thử lại.');
      }
      if (!gen || !gen.success || !gen.replyText) throw new Error((gen && gen.error) || 'AI không trả về nội dung reply.');

      setLabel(info.id, 'Đang gửi...', 'busy', 0);
      await dismissLeftoverComposer();
      const target = homeFindArticleById(info.id) || article;
      await replyViaComposerModal(target, gen.replyText);

      if (gen.likeAfterReply) {
        await wait(800);
        const art = homeFindArticleById(info.id) || target;
        const likeBtn = art.querySelector('[data-testid="like"]'); // đã like rồi thì testid là "unlike" -> bỏ qua
        if (likeBtn) {
          art.scrollIntoView({ block: 'center' });
          await wait(400);
          likeBtn.click();
          await wait(500);
        }
      }
      setLabel(info.id, 'Đã reply ✓', 'ok', 4000, gen.replyText);
    } catch (e) {
      console.error('[Reply AI]', e);
      setLabel(info.id, 'Lỗi - bấm lại', 'error', 6000, e && e.message ? e.message : 'Lỗi không rõ.');
    } finally {
      working = false;
    }
  }

  function inject(article) {
    if (article.querySelector('[data-testid="placementTracking"]')) return; // bỏ quảng cáo
    const bar = findActionBar(article);
    if (!bar) return;
    const existing = bar.querySelector(`:scope > [${HOST_ATTR}]`);
    if (existing) { // đã có nút - chỉ đồng bộ lại id bài phòng X tái sử dụng khung bài cho bài khác
      const pid = currentPostId(article);
      if (pid && existing.getAttribute('data-post-id') !== pid) existing.setAttribute('data-post-id', pid);
      return;
    }

    const host = document.createElement('div');
    host.setAttribute(HOST_ATTR, '1');
    host.setAttribute('data-post-id', currentPostId(article));
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = IDLE_LABEL;
    btn.title = IDLE_TITLE;
    btn.dataset.kind = 'idle';
    // Chặn click lan lên bài (X sẽ mở trang chi tiết bài nếu click chạm vào vùng bài).
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClickReplyAi(article);
    });
    root.append(style, btn);
    buttons.add({ host, btn });

    // Chèn NGAY TRƯỚC khối Bookmark (khối con trực tiếp của thanh hành động) = khoảng trống giữa Views và Bookmark.
    const bm = bar.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]');
    let anchor = bm;
    while (anchor && anchor.parentElement !== bar) anchor = anchor.parentElement;
    if (anchor) bar.insertBefore(host, anchor);
    else bar.appendChild(host);
    paintState();
  }

  function scan() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(inject);
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => { scanQueued = false; scan(); });
  }

  function enable() {
    if (observer || !document.body) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  if (document.body) enable();
  else document.addEventListener('DOMContentLoaded', enable, { once: true });
})();
// Lướt Home trong thời gian nghỉ sau khi Content Crypto đăng xong.
let humanBrowseToken = null;

function hbRand(min, max) { return min + Math.random() * (max - min); }
function hbRandInt(min, max) { return Math.floor(hbRand(min, max + 1)); }

async function hbSleep(token, ms) {
  const end = Date.now() + ms;
  while (!token.stopped && Date.now() < end) {
    await wait(Math.min(500, Math.max(0, end - Date.now())));
  }
}

function hbClick(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  try {
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
  } catch (e) {  }
  el.click();
}

function hbOnHome() {
  return /^\/home(\/|$|\?)/.test(location.pathname);
}

function hbFindHomeLink() {
  return document.querySelector('a[data-testid="AppTabBar_Home_Link"]')
    || document.querySelector('nav a[href="/home"]')
    || document.querySelector('a[href="/home"][role="link"]');
}

async function hbWaitFeed(token, maxMs) {
  const end = Date.now() + maxMs;
  while (!token.stopped && Date.now() < end) {
    if (hbOnHome() && getTopLevelArticles().length > 0) return true;
    await wait(500);
  }
  return hbOnHome() && getTopLevelArticles().length > 0;
}

async function hbGoHome(token) {
  const link = hbFindHomeLink();
  if (!link) return false;
  hbClick(link);
  await wait(1500);
  return await hbWaitFeed(token, 15000);
}

async function hbRefreshTimeline(token) {
  const link = hbFindHomeLink();
  if (!link) return false;
  hbClick(link);
  await hbSleep(token, hbRand(500, 1000));
  if (token.stopped) return true;
  hbClick(hbFindHomeLink() || link);
  await hbSleep(token, hbRand(2500, 4000));
  await hbWaitFeed(token, 10000);
  return true;
}

async function hbScroll(token, dir, distance) {
  let left = Math.abs(distance);
  while (left > 0 && !token.stopped) {
    const step = Math.min(left, hbRandInt(40, 140));
    scrollFeed(dir * step);
    left -= step;
    await wait(hbRandInt(16, 45));
  }
  token.scrolled += Math.abs(distance);
}

async function hbOpenRandomPostAndBack(token) {
  const vh = window.innerHeight;
  const cands = getTopLevelArticles().filter((a) => {
    const r = a.getBoundingClientRect();
    if (r.top < 60 || r.top > vh * 0.65) return false;
    const info = homeReadArticle(a);
    return !!(info && !info.isAd);
  });
  if (cands.length === 0) return false;

  const article = cands[hbRandInt(0, cands.length - 1)];
  const timeEl = article.querySelector('a[href*="/status/"] time');
  const link = timeEl ? timeEl.closest('a') : null;
  if (!link) return false;

  hbClick(link);
  for (let i = 0; i < 12 && !token.stopped && !/\/status\/\d+/.test(location.pathname); i++) await wait(500);
  if (!/\/status\/\d+/.test(location.pathname)) return false;

  await hbSleep(token, hbRand(2500, 5000));
  if (!token.stopped && Math.random() < 0.6) {
    await hbScroll(token, 1, hbRandInt(150, 500));
    await hbSleep(token, hbRand(1500, 4000));
    if (Math.random() < 0.5) await hbScroll(token, -1, hbRandInt(100, 400));
  }
  if (token.stopped) return true;
  await hbSleep(token, hbRand(800, 2000));

  const back = document.querySelector('[data-testid="app-bar-back"]');
  if (back) hbClick(back); else history.back();
  for (let i = 0; i < 12 && !token.stopped && !hbOnHome(); i++) await wait(500);
  if (!hbOnHome()) await hbGoHome(token);
  else await hbWaitFeed(token, 8000);
  return true;
}

async function runHumanBrowse(token) {
  let sinceOpen = 0;
  let refreshAt = hbRandInt(5000, 9000);
  while (!token.stopped && Date.now() < token.deadline) {
    if (!hbOnHome()) {
      if (!(await hbGoHome(token))) break;
    }

    if (token.scrolled >= refreshAt) {
      await hbRefreshTimeline(token);
      token.scrolled = 0;
      refreshAt = hbRandInt(5000, 9000);
      sinceOpen = 0;
      continue;
    }

    if (sinceOpen >= 4 && Math.random() < 0.15) {
      sinceOpen = 0;
      await hbOpenRandomPostAndBack(token);
      continue;
    }
    sinceOpen++;

    await hbInteractVisiblePost(token);
    if (token.stopped) break;
    const goUp = Math.random() < 0.22;
    await hbScroll(token, goUp ? -1 : 1, goUp ? hbRandInt(200, 700) : hbRandInt(300, 900));

    await hbSleep(token, Math.random() < 0.12 ? hbRand(5000, 9000) : hbRand(1000, 3500));
  }
}

async function startHumanBrowseHome(durationMs, alreadyHome) {
  stopHumanBrowseHome();
  try { await dismissLeftoverComposer(); } catch (e) {  }

  const token = { stopped: false, scrolled: 0, deadline: Date.now() + Math.max(0, Number(durationMs) || 0) + 20000 };
  humanBrowseToken = token;
  const saved = await chrome.storage.local.get('restInteractionCfg');
  if (token.stopped || humanBrowseToken !== token) return { started: false };
  token.interactionCfg = saved.restInteractionCfg || {};
  token.examined = new Set();
  humanBrowseToken = token;

  let ready = false;
  if (alreadyHome && hbOnHome()) ready = await hbWaitFeed(token, 15000);
  else ready = await hbGoHome(token);
  if (!ready) {
    if (humanBrowseToken === token) humanBrowseToken = null;
    throw new Error('Không bấm được nút Home hoặc timeline Home chưa tải.');
  }

  runHumanBrowse(token)
    .catch(() => {})
    .finally(() => { if (humanBrowseToken === token) humanBrowseToken = null; });
  return { started: true };
}

function stopHumanBrowseHome() {
  if (humanBrowseToken) humanBrowseToken.stopped = true;
  humanBrowseToken = null;
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'HUMAN_BROWSE_HOME_START') {
    startHumanBrowseHome(request.durationMs, request.alreadyHome)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (request.action === 'HUMAN_BROWSE_HOME_STOP') {
    stopHumanBrowseHome(); sendResponse({ success: true });
  }
});

function hbPickInteraction(cfg, randomValue) {
  const percent = value => Math.min(100, Math.max(0, Number(value) || 0));
  const comment = percent(cfg.commentLikePercent);
  const like = Math.min(100 - comment, percent(cfg.likeOnlyPercent));
  const roll = randomValue * 100;
  return roll < comment ? 'commentLike' : roll < comment + like ? 'likeOnly' : 'read';
}

async function hbInteractVisiblePost(token) {
  if (token.stopped || Date.now() >= token.deadline || !hbOnHome()) return;
  const cfg = token.interactionCfg || {};
  if (!(Number(cfg.commentLikePercent) > 0 || Number(cfg.likeOnlyPercent) > 0)) return;
  const ownUsername = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.split('/')[1]?.toLowerCase();
  if (!ownUsername) return; // Không tương tác nếu chưa xác định được tài khoản hiện tại.
  const candidates = getTopLevelArticles().map(article => ({article, post: homeReadArticle(article)}))
    .filter(({article, post}) => {
      const bounds = article.getBoundingClientRect();
      return post && !post.isAd && post.text && post.hasReplyBtn && !token.examined.has(post.id)
        && post.username.toLowerCase() !== ownUsername && bounds.top >= 50 && bounds.top < innerHeight * .8;
    });
  const candidate = candidates[0];
  if (!candidate) return;
  const { article, post } = candidate;
  token.examined.add(post.id);
  const action = hbPickInteraction(cfg, Math.random());
  if (action === 'read') return;
  try {
    if (action === 'commentLike') {
      // Sinh văn bản trước; chỉ gửi nếu phiên nghỉ vẫn còn hoạt động.
      const response = await chrome.runtime.sendMessage({ action: 'REPLY_AI_GENERATE', text: post.text, lang: post.lang, username: post.username });
      if (!response?.success || !response.replyText) throw new Error(response?.error || 'Không tạo được comment');
      if (token.stopped || humanBrowseToken !== token || Date.now() >= token.deadline) return;
      await homeReplyToPost(post.id, response.replyText, true);
    } else {
      if (token.stopped || humanBrowseToken !== token) return;
      const like = article.querySelector('[data-testid="like"]');
      if (like) { like.click(); await hbSleep(token, 700); }
    }
  } catch (error) {
    chrome.runtime.sendMessage({ action: 'REST_INTERACTION_LOG', error: error.message }).catch(() => {});
  }
}
