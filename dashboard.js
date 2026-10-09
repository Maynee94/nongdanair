// dashboard.js - Xử lý Giao diện Side panel & Logic điều khiển tự động

// ============== TIMER CHẠY TRONG WEB WORKER (chống bị làm chậm khi cửa sổ Chrome bị che / thu nhỏ) ==============
// Toàn bộ vòng lặp tự động (Chéo Link, Follow, Tương Tác Username/Home, hẹn giờ...) chạy bằng setTimeout /
// setInterval NGAY TẠI side panel. Khi cửa sổ Chrome chứa panel bị che khuất hoặc thu nhỏ (VD: đang dùng 1
// profile Chrome khác đè lên), Chrome coi trang là "ẩn" và làm chậm timer: tối thiểu 1 giây/lần, sau ~5 phút
// còn 1 phút/lần -> đếm ngược, delay giữa các link, hẹn giờ đều bị trễ/đứng. Timer trong Web Worker không bị
// làm chậm kiểu đó, nên ở đây thay setTimeout/setInterval/clearTimeout/clearInterval bằng bản chạy qua worker
// (file timer-worker.js). Chỉ bật SAU KHI worker trả lời "pong" - nếu thiếu file / worker lỗi thì giữ nguyên
// timer gốc của trình duyệt, mọi thứ vẫn chạy như cũ.
(function installWorkerTimers() {
  if (typeof Worker === 'undefined') return;
  let worker;
  try { worker = new Worker('timer-worker.js'); } catch (e) { return; }

  const native = {
    setTimeout: window.setTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    clearInterval: window.clearInterval.bind(window),
  };
  const ID_BASE = 1e9; // id của timer worker luôn >= ID_BASE để không lẫn với id timer gốc
  let nextId = ID_BASE;
  let installed = false;
  const records = new Map(); // id -> { fn, args, once }

  worker.onmessage = (e) => {
    const d = e.data || {};
    if (d.cmd === 'pong') { install(); return; }
    const rec = records.get(d.id);
    if (!rec) return;
    if (rec.once) records.delete(d.id);
    rec.fn(...rec.args);
  };
  worker.onerror = () => { /* không tải được worker -> giữ nguyên timer gốc */ };

  function makeSchedule(once) {
    return function (fn, ms, ...args) {
      if (typeof fn !== 'function') return (once ? native.setTimeout : native.setInterval)(fn, ms, ...args);
      const id = nextId++;
      records.set(id, { fn, args, once });
      worker.postMessage({ cmd: once ? 'timeout' : 'interval', id, ms: Math.max(0, Number(ms) || 0) });
      return id;
    };
  }

  function makeClear(nativeClear) {
    return function (id) {
      if (typeof id === 'number' && id >= ID_BASE) {
        if (records.delete(id)) worker.postMessage({ cmd: 'clear', id });
        return;
      }
      nativeClear(id);
    };
  }

  function install() {
    if (installed) return;
    installed = true;
    window.setTimeout = makeSchedule(true);
    window.setInterval = makeSchedule(false);
    window.clearTimeout = makeClear(native.clearTimeout);
    window.clearInterval = makeClear(native.clearInterval);
  }

  worker.postMessage({ cmd: 'ping' });
})();

let projectTagInput = null;
let kolTagInput = null;

let currentAbortController = null;

// Các tính năng đang bị TẠM DỪNG vì tới giờ hẹn tạo/đăng bài (xem pauseAllFlowsForSchedule).
// Sau khi bài hẹn giờ chạy xong, đúng những tính năng trong danh sách này sẽ tự chạy lại.
let flowsPausedForSchedule = new Set();

let isHomeInteractRunning = false;
let homeInteractStats = { success: 0, fail: 0 };
let homeInteractTabId = null;
let homeWindows = []; // [{ from: '08:00', to: '10:00' }] - khung giờ chạy của Tương tác Home (giờ máy tính)

let toastHideTimer = null;

const MAX_LOG_ENTRIES = 300;

// ============== NHẬT KÝ HOẠT ĐỘNG - MỖI TAB / TIỆN ÍCH 1 NHẬT KÝ RIÊNG ==============
// Trước đây mọi tính năng ghi chung vào 1 khung "Nhật ký hoạt động" ở cuối trang nên log của
// Tạo Content, Chéo Link, Follow, Telegram... bị lẫn hết vào nhau. Nay mỗi tab có 1 nhật ký
// riêng, đặt ngay trong tab đó (xem các khối .log-card trong dashboard.html).
// Cách dùng: gọi logEvent với 3 tham số (kênh, nội dung, mức) - "kênh" là 1 khoá của LOG_CHANNELS bên dưới.
const LOG_CHANNELS = {
  create:       { listId: 'logListCreate',       clearId: 'btnClearLogCreate' },       // HOME > Tạo Content
  settings:     { listId: 'logListSettings',     clearId: 'btnClearLogSettings' },     // SETTING
  homeInteract: { listId: 'logListHomeInteract', clearId: 'btnClearLogHomeInteract' }, // TIỆN ÍCH > Tương tác Home
};
const logStore = {};
Object.keys(LOG_CHANNELS).forEach((ch) => { logStore[ch] = []; });

// Thêm 1 dòng vào kênh (mới nhất ở trên cùng) nhưng CHƯA vẽ lại - dùng khi cần thêm nhiều dòng liền.
function addLogEntry(channel, entry) {
  const list = logStore[channel];
  if (!list) return;
  list.unshift(entry);
  if (list.length > MAX_LOG_ENTRIES) list.length = MAX_LOG_ENTRIES;
}

function logEvent(channel, message, level = 'info') {
  if (!LOG_CHANNELS[channel]) {
    console.warn('logEvent: kênh log không tồn tại:', channel, message);
    return;
  }
  const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  addLogEntry(channel, { time, message, level });
  renderLog(channel);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str == null ? '' : String(str);
  return div.innerHTML;
}

function renderLog(channel) {
  const cfg = LOG_CHANNELS[channel];
  if (!cfg) return;
  const list = document.getElementById(cfg.listId);
  if (!list) return;
  const entries = logStore[channel];
  if (entries.length === 0) {
    list.innerHTML = '<div class="log-empty">Chưa có hoạt động nào.</div>';
    return;
  }
  list.innerHTML = entries
    .map((e) => `<div class="log-entry ${e.level}"><span class="log-time">${e.time}</span>${escapeHtml(e.message)}</div>`)
    .join('');
}

function renderAllLogs() {
  Object.keys(LOG_CHANNELS).forEach(renderLog);
}

// Mỗi nhật ký có nút "Xoá" riêng - chỉ xoá đúng nhật ký của tab đó.
function bindLogClearButtons() {
  Object.entries(LOG_CHANNELS).forEach(([channel, cfg]) => {
    const btn = document.getElementById(cfg.clearId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      logStore[channel] = [];
      renderLog(channel);
    });
  });
}

// Các field không có nút Lưu riêng -> tự động lưu khi nhập (debounce) + hiện toast
const TEXT_AUTOSAVE_FIELDS = [
  ['crossLinkWordMin', 'crossLinkWordMin'],
  ['crossLinkWordMax', 'crossLinkWordMax'],
  ['crossLinkCustomStyle', 'crossLinkCustomStyle'],
  ['homeInteractMaxInput', 'homeInteractMax'],
  ['homeInteractDelayInput', 'homeInteractDelay'],
  ['homeInteractWordMin', 'homeInteractWordMin'],
  ['homeInteractWordMax', 'homeInteractWordMax'],
  ['homeInteractCustomStyle', 'homeInteractCustomStyle'],
  ['homeInteractPauseAfterInput', 'homeInteractPauseAfter'],
  ['homeInteractPauseDurationInput', 'homeInteractPauseDuration'],
  ['homeSkipLangInput', 'homeSkipLang'],
  // Tab Cài Đặt - trước đây chỉ lưu khi bấm nút "Lưu Cài Đặt" (đã bỏ nút này),
  // giờ tự lưu ngay khi nhập/đổi như mọi field khác trong app.
  ['openaiKeyInput', 'openaiKey'],
  ['geminiKeyInput', 'geminiKey'],
  ['deepseekKeyInput', 'deepseekKey'],
  ['charLimitMin', 'charLimitMin'],
  ['charLimitMax', 'charLimitMax'],
  ['imageExtraPrompt', 'imageExtraPrompt'],
  ['typingSpeedMinInput', 'typingSpeedMin'],
  ['typingSpeedMaxInput', 'typingSpeedMax'],
];

const SELECT_AUTOSAVE_FIELDS = [
  ['aiModelSelect', 'aiModel'],
  ['geminiModelSelect', 'geminiModel'],
  ['deepseekModelSelect', 'deepseekModel'],
];

// Chữ hiển thị trạng thái chung cho các nút chạy (thay cho chữ tiếng Anh cũ).
const STATUS_IDLE = 'Nhàn Rỗi';
const STATUS_RUNNING = 'Đang Chạy';

const CHIP_GROUPS = ['contentSource', 'postType', 'needMedia', 'imageSource', 'tone', 'crossLinkLang', 'crossLinkTone', 'homeInteractSource', 'homeInteractLang', 'homeInteractTone', 'contentLang', 'tagTarget', 'postMode'];

// Bộ quy tắc BẮT BUỘC áp dụng cho MỌI prompt gọi AI (dù dùng phong cách mặc định hay
// người dùng dán phong cách riêng) để tránh các dấu hiệu nhận biết văn bản do AI viết.
const ANTI_AI_STYLE_GUIDE = `QUY TẮC BẮT BUỘC (áp dụng cho MỌI trường hợp, kể cả khi đã có phong cách riêng ở trên - không được bỏ qua):
- Không nhấn mạnh thái quá tầm quan trọng, di sản hay ảnh hưởng của chủ thể.
- Không dùng quy chiếu mơ hồ, không rõ nguồn (vd: "một số người cho rằng", "nhiều chuyên gia nhận định") nếu không có nguồn cụ thể.
- Không phóng đại số lượng nguồn/bằng chứng, không ngụ ý danh sách ví dụ "chưa đầy đủ" nếu thực tế không phải vậy.
- Tránh các từ/cụm AI hay lạm dụng: delve, boast, tapestry, testament, leverage, ignite, unlock, unleash, journey, realm, elevate, "không chỉ... mà còn...".
- TUYỆT ĐỐI tránh kiểu tính từ ghép có gạch nối đặc trưng văn phong AI (dạng "[danh từ]-[tính từ]" ghép lại để nghe "sang" hơn), ví dụ: real-life, real-world, base-level, next-level, cutting-edge, game-changing, top-tier, best-in-class. Viết lại bằng cụm từ tự nhiên hơn thay vì ghép gạch nối kiểu này.
- TUYỆT ĐỐI tránh lạm dụng sở hữu cách 's gắn vào khái niệm/công nghệ trừu tượng hoặc tên dự án (ví dụ "Physical AI's potential", "blockchain's future", "@vangrid_io's mission") - đây là văn phong AI rất đặc trưng. Viết lại tự nhiên hơn bằng cấu trúc "of" hoặc diễn đạt khác (ví dụ "the potential of Physical AI", "vangrid_io's mission" chỉ chấp nhận được khi chủ thể là 1 người/tổ chức cụ thể được nhắc lần đầu, không lạm dụng lặp lại kiểu này nhiều lần trong 1 bài ngắn).
- Không liệt kê kiểu 3 tính từ/cụm từ liền nhau trong 1 câu.
- Không dùng câu kết sáo rỗng lặp đi lặp lại kiểu "Tóm lại", "Nhìn chung", và không chêm bình luận kiểu biên tập viên ("điều quan trọng cần lưu ý là...", "đáng chú ý là...").
- TUYỆT ĐỐI không dùng bullet/gạch đầu dòng, không in đậm tiêu đề kèm dấu hai chấm, không viết hoa toàn bộ tiêu đề, không dùng em dash "—" (dùng dấu phẩy/dấu chấm/xuống dòng thay thế), dùng dấu ngoặc kép thẳng (" ") thay vì ngoặc kép cong (" ").
- Không được để sót câu miễn trừ trách nhiệm kiểu AI (vd: "Là một mô hình ngôn ngữ AI...") hay đoạn hướng dẫn/placeholder chưa điền vào.
- Viết tự nhiên như người thật gõ tay: câu ngắn dài xen kẽ, giọng văn có cá tính riêng, không cần hoàn hảo tuyệt đối về ngữ pháp.`;

// ============== BỘ PROMPT DÀNH RIÊNG CHO REPLY ==============
// VẤN ĐỀ CŨ: mọi prompt reply đều nhét nguyên ANTI_AI_STYLE_GUIDE (bộ quy tắc viết cho
// BÀI ĐĂNG DÀI) vào, dẫn tới 3 hệ quả khiến reply nghe rất "AI":
//   (1) Bộ quy tắc đó TOÀN LỆNH CẤM, không có lệnh khẳng định nào. Bị cấm hết mọi hướng
//       thì model rút về vùng an toàn: câu trung tính, đúng ngữ pháp, không quan điểm -
//       đúng cái mùi AI rõ nhất.
//   (2) Quá nửa số rule ("không bullet", "không viết Tóm lại", "không in đậm tiêu đề"...)
//       vô nghĩa với 1 câu reply 15 từ, chỉ làm loãng prompt: ~1500 ký tự luật đè lên
//       ~200 ký tự nhiệm vụ thật.
//   (3) Câu lệnh "soạn 1 câu reply đúng ngữ cảnh" đẻ ra đúng mẫu reply AI kinh điển:
//       tóm tắt lại bài + thêm 1 câu tích cực chung chung.
// SỬA: tách riêng bộ hướng dẫn cho reply - ngắn, đặc thù reply, có phần KHẲNG ĐỊNH mô tả
// giọng người thật, bắt model chọn 1 PHẢN ỨNG trước khi viết, và mỗi lượt reply bốc ngẫu
// nhiên 1 GÓC TIẾP CẬN khác nhau (xem REPLY_ANGLES) để 20 reply trong cùng 1 lượt chạy
// không giống hệt nhau về cấu trúc - thứ lộ bot nhanh nhất ở một tool tự động.

const ANTI_AI_REPLY_GUIDE = `CÁCH VIẾT REPLY (phần quan trọng nhất, đọc kỹ):

BƯỚC BẮT BUỘC TRƯỚC KHI VIẾT: tự trả lời trong đầu "đọc xong bài này mình thấy gì?". Phải có MỘT phản ứng cụ thể - đồng tình vì lý do gì, gợn ở chỗ nào, buồn cười chỗ nào, tò mò điều gì - rồi mới viết chính phản ứng đó ra. Không có phản ứng thật thì không viết ra được reply của người thật.

PHÉP THỬ BẮT BUỘC: reply viết xong, thử tưởng tượng dán nó sang một bài đăng hoàn toàn khác. Nếu vẫn hợp lý thì reply đó SAI - nó rỗng. Phải viết lại sao cho bám vào một CHI TIẾT CỤ THỂ trong bài: một con số, một cái tên, một tính năng, một câu người ta vừa nói.

TUYỆT ĐỐI KHÔNG:
- Tóm tắt hay nhắc lại ý bài đăng rồi mới bình luận. Vào thẳng phản ứng.
- Khen người đăng hoặc khen bài viết: "great thread", "great point", "well said", "insightful", "góc nhìn hay", "bài chất lượng", "phân tích sâu sắc".
- Mở đầu bằng từ tán thành rỗng: "Absolutely", "Indeed", "Exactly", "Totally agree", "Chuẩn", "Chuẩn luôn", "Quá đúng", "Đồng ý".
- Câu sáo rỗng vô nghĩa: "This is huge", "Big if true", "Exciting times ahead", "The future is bright", "Looking forward to seeing where this goes", "Tương lai đáng mong đợi", "Chờ xem sao", "Hóng", "Đáng để theo dõi".
- Kết bằng câu hỏi tu từ chung chung mà bản thân không thật sự quan tâm câu trả lời.
- Dùng emoji, hashtag, hoặc gắn thêm @ ai đó.
- Viết kiểu thông cáo báo chí, kiểu tổng kết hộ người ta, hay kiểu giảng bài.
- Nói về "tiềm năng", "ứng dụng", "giá trị" của thứ gì đó một cách trừu tượng.

ĐƯỢC PHÉP VÀ NÊN LÀM:
- KHÔNG ĐỒNG TÌNH. Chỉ ra chỗ chưa thuyết phục, nói thẳng là chưa chắc, nêu một phản ví dụ. Reply hay nhất thường là reply không gật đầu.
- Đùa, cà khịa nhẹ, nói mát, châm biếm có duyên (nhưng không xúc phạm, không công kích cá nhân, không đụng chuyện nhạy cảm).
- Hỏi ngược một câu hỏi THẬT: đúng cái mình muốn biết sau khi đọc bài, bám vào chi tiết cụ thể.
- Kể một mẩu quan sát/trải nghiệm rất ngắn của bản thân.
- Viết câu cụt, câu què, thiếu chủ ngữ. Không cần dấu chấm cuối câu. Không cần viết hoa đầu câu.
- Dùng từ đơn giản, đời thường, đúng từ mà người ta gõ trên X. Reply 4-6 từ hoàn toàn ổn và thường tốt hơn reply dài.
- Được phép hơi chủ quan, hơi lệch, hơi cảm tính. Người thật không trung lập.`;

// Mỗi reply bốc 1 góc khác nhau -> 20 reply trong 1 lượt chạy khác nhau về DẠNG, không chỉ
// khác về chữ. Đây là thứ quyết định việc nhìn vào có ra bot hay không.
const REPLY_ANGLES = [
  'GÓC CHO REPLY LẦN NÀY: đồng tình, nhưng phải bổ sung thêm 1 chi tiết hoặc 1 góc nhìn mà bài chưa nhắc tới. Đồng tình suông không được tính.',
  'GÓC CHO REPLY LẦN NÀY: gợn một điểm. Nói ra chỗ trong bài mà bạn thấy chưa thuyết phục, còn thiếu, hoặc nói hơi quá.',
  'GÓC CHO REPLY LẦN NÀY: phản bác thẳng. Bạn không đồng ý và nói rõ vì sao, ngắn gọn, không vòng vo.',
  'GÓC CHO REPLY LẦN NÀY: hỏi ngược. Một câu hỏi thật sự muốn biết, bám vào một chi tiết cụ thể trong bài, không phải câu hỏi tu từ.',
  'GÓC CHO REPLY LẦN NÀY: đùa hoặc cà khịa nhẹ về một chi tiết trong bài.',
  'GÓC CHO REPLY LẦN NÀY: kể một mẩu trải nghiệm hoặc quan sát rất ngắn của bản thân liên quan tới bài.',
  'GÓC CHO REPLY LẦN NÀY: phản ứng cực ngắn, 3-7 từ, kiểu câu bật ra ngay khi đọc xong. Không giải thích gì thêm.',
  'GÓC CHO REPLY LẦN NÀY: suy ra hệ quả. Nói ra điều sẽ xảy ra tiếp theo hoặc hệ quả mà bài chưa nhắc tới.',
  'GÓC CHO REPLY LẦN NÀY: soi vào đúng một chi tiết nhỏ trong bài (một con số, một cái tên, một từ người ta dùng) và bình luận riêng về chi tiết đó, bỏ qua phần còn lại.',
  'GÓC CHO REPLY LẦN NÀY: đồng tình nhưng kèm một điều kiện hoặc một chữ "nếu" - kiểu "đúng, với điều kiện là...".'
];

function pickReplyAngle() {
  return REPLY_ANGLES[Math.floor(Math.random() * REPLY_ANGLES.length)];
}

// Mô tả giọng cho REPLY - dày hơn hẳn getToneDescription (vốn chỉ 1 câu 6 chữ, quá mỏng
// để model bám theo nên nó luôn rơi về giọng mặc định). Mỗi giọng kèm ví dụ ❌/✅ song ngữ
// để model thấy được KHOẢNG CÁCH giữa reply AI và reply người thật.
const REPLY_TONE_GUIDES = {
  informative: `GIỌNG: người có đọc, có hiểu vấn đề, nói chuyện điềm tĩnh và thẳng. Không lên gân, không hype. Có thể nêu một chi tiết kỹ thuật hoặc một so sánh cụ thể. Vẫn viết như đang nói chuyện, không như đang viết báo cáo.
❌ "Đây là một bước tiến quan trọng, tiềm năng ứng dụng của công nghệ này là rất lớn."
✅ "cái khó không nằm ở throughput đâu, nằm ở lúc rollback"
❌ "Great breakdown, the potential here is enormous."
✅ "the hard part isn't throughput, it's what happens on rollback"`,

  neutral: `GIỌNG: bình thường, lịch sự, không nghiêng về phía nào, không hype cũng không mỉa. Ngắn gọn, đúng trọng tâm, như một người dùng X bình thường lướt qua và có một ý kiến.
❌ "Cảm ơn bạn đã chia sẻ, đây là thông tin rất hữu ích."
✅ "phần số liệu lấy từ đâu vậy, mình tìm không ra bản gốc"
❌ "Thanks for sharing, this is really useful information."
✅ "where's the number from? can't find the original"`,

  kol_insight: `GIỌNG: người trong ngành, đã ở đây đủ lâu, đã thấy nhiều lần rồi. Nói ngắn, có quan điểm rõ, hơi thẳng, đôi khi hơi mệt mỏi vì đã thấy mô-típ này. Viết thường, câu cụt, không cần dấu chấm cuối. Được phép so sánh với những lần trước trong ngành.
❌ "Với kinh nghiệm quan sát thị trường, tôi cho rằng đây là xu hướng đáng chú ý."
✅ "y hệt cái vòng 2021, chỉ khác cái tên"
❌ "From my experience observing the market, this is a noteworthy trend."
✅ "same cycle as 2021, different name"`,

  bullish: `GIỌNG: tin vào thứ đang nói, có năng lượng thật, nhưng năng lượng đó phải đến từ một LÝ DO CỤ THỂ trong bài, không phải hô khẩu hiệu. Hype rỗng còn tệ hơn giọng trung lập.
❌ "This is huge! The future is incredibly bright for this project!"
✅ "phí gas giảm 10 lần mà vẫn giữ được finality, chỗ này mới đáng nói"
❌ "Tương lai của dự án này thực sự rất đáng mong đợi!"
✅ "nếu con số 10x này giữ được sau mainnet thì mọi thứ khác trong bài thành phụ"`,

  degen: `GIỌNG: rất đời, rất X/crypto twitter. Viết thường toàn bộ, slang, câu gãy, meme, cà khịa, nói mát. Không cần ngữ pháp. Cực ngắn cũng được. Nhưng vẫn phải bám vào một chi tiết thật trong bài, không phải nhại meme vu vơ.
❌ "Rất hào hứng với sự phát triển của dự án này 🚀"
✅ "roadmap dài 4 trang mà testnet chưa mở, ok"
❌ "Bullish on this, the tech is solid."
✅ "ok but who's actually running a node lol"`
};

function getReplyToneGuide(tone) {
  return REPLY_TONE_GUIDES[tone] || REPLY_TONE_GUIDES.informative;
}

// Khối phong cách dùng chung cho MỌI luồng reply (Chéo Link, Tương tác Home, Tương tác
// Username, Reply Comment, nút Reply AI). Gộp: giọng + góc ngẫu nhiên + bộ quy tắc reply.
function buildReplyStyleBlock(tone, lengthInstruction, styleInstruction) {
  const parts = [getReplyToneGuide(tone), pickReplyAngle()];
  if (lengthInstruction) parts.push(lengthInstruction);
  if (styleInstruction) parts.push(`PHONG CÁCH RIÊNG do người dùng chỉ định (ưu tiên cao, áp dụng đè lên phần giọng ở trên): ${styleInstruction}`);
  parts.push(ANTI_AI_REPLY_GUIDE);
  const fewShotBlock = pickOwnerStyleFewShotBlock();
  if (fewShotBlock) parts.push(fewShotBlock);
  return parts.join('\n\n');
}

// Reply Comment là trường hợp KHÁC HẲN: đây là bạn trả lời người vào comment dưới bài của
// CHÍNH MÌNH - tức bạn đang ở vai chủ nhà. Bộ góc tiếp cận ở trên (phản bác thẳng, cà khịa,
// soi chi tiết) hoàn toàn không hợp ở đây, dùng nhầm sẽ thành gây war với người ủng hộ mình.
// Nên tách riêng bộ góc cho vai chủ nhà: vẫn phải có cảm xúc thật, chỉ khác là không đối đầu.
const OWNER_REPLY_ANGLES = [
  'GÓC CHO REPLY LẦN NÀY: trả lời thẳng vào đúng điều người ta hỏi hoặc thắc mắc, ngắn gọn, không vòng vo.',
  'GÓC CHO REPLY LẦN NÀY: bắt đúng một chữ hoặc một ý trong comment của họ và phản hồi riêng vào chỗ đó, cho thấy bạn thật sự có đọc.',
  'GÓC CHO REPLY LẦN NÀY: đùa lại nhẹ theo đúng mạch comment của họ.',
  'GÓC CHO REPLY LẦN NÀY: hỏi ngược lại họ một câu thật, để nối tiếp câu chuyện.',
  'GÓC CHO REPLY LẦN NÀY: bổ sung thêm một thông tin hoặc chi tiết mà bài gốc chưa kịp nói, đúng cái họ đang quan tâm.',
  'GÓC CHO REPLY LẦN NÀY: thừa nhận họ nói đúng một điểm, hoặc thừa nhận chỗ mình còn thiếu - thẳng thắn, không phòng thủ.',
  'GÓC CHO REPLY LẦN NÀY: phản ứng cực ngắn và ấm, 3-6 từ, kiểu người thật gõ nhanh khi thấy comment.'
];

const OWNER_REPLY_GUIDE = `BẠN ĐANG Ở VAI CHỦ BÀI ĐĂNG: người này vào comment dưới bài của chính bạn. Trả lời họ như chủ nhà tiếp khách - thân, thẳng, không khách sáo, không đối đầu.

TUYỆT ĐỐI KHÔNG:
- Cảm ơn sáo rỗng rồi hết: "Cảm ơn bạn đã quan tâm", "Cảm ơn góp ý của bạn", "Thanks for your support", "Appreciate it". Nếu muốn cảm ơn thì phải kèm một nội dung thật ngay sau đó.
- Trả lời chung chung áp dụng cho comment nào cũng được. Phải bám vào đúng chữ họ vừa viết.
- Nói giọng chăm sóc khách hàng, giọng admin fanpage, hay giọng thông cáo.
- Dùng emoji, hashtag.
- Gây war, mỉa mai, hạ thấp người comment - kể cả khi comment của họ tiêu cực hay sai. Comment tiêu cực thì trả lời điềm tĩnh, ngắn, có thông tin.
- Hứa hẹn những điều bạn không chắc.

NÊN: viết ngắn, đúng trọng tâm, có cá tính. Câu cụt được. Không cần dấu chấm cuối. Một reply 4-6 từ hoàn toàn ổn.`;

function pickOwnerReplyAngle() {
  return OWNER_REPLY_ANGLES[Math.floor(Math.random() * OWNER_REPLY_ANGLES.length)];
}

// Kho 92 mẫu "post thật + reply thật" do người dùng tự sưu tầm/biên soạn, dùng làm VÍ DỤ
// FEW-SHOT cho AI học văn phong TRƯỚC KHI viết reply thật - áp dụng cho MỌI luồng reply
// (Chéo Link, Tương tác Home, Tương tác Username, nút Reply AI, Reply Comment), KHÔNG áp
// dụng cho Tạo Content (bài đăng dài, văn phong khác hẳn 1 câu reply ngắn). Không cố định
// 1 bộ ví dụ mỗi lần (quá dài, tốn token, dễ khiến AI học vẹt) mà random chọn ra vài mẫu
// khác nhau mỗi lần gọi, xem pickOwnerStyleFewShotBlock() bên dưới.
const NYX_OWNER_STYLE_SAMPLES = [{"post": "Cả nhà ơi có job Web3 nào ngon giới thiệu mình với. Thấy ae khoe lương Web3 hoài mà mình vẫn đang tìm cơ hội. Ai có kèo phù hợp cho xin một slot.", "replies": ["tui còn đói đây nè sao gt", "đói lắm sao gt fen", "mình cũng đang đói lè lưỡi nè"]}, {"post": "Vlad Tenev nhắc alpha là RWA và AI. Kiếm thêm alpha hai mảng đó mà cày air. AE degen thì săn AI Agents và RWA.", "replies": ["mùa này cũng khó mà cày air", "airdrop mùa này ngáp ngáp", "airdrop giờ toàn nước mắt"]}, {"post": "Sao mà vào con nào là con đó chia 2. Sao người ta vào lại x10-x100. Nhiều lúc muốn chửi thề thật chứ.", "replies": ["cái số nó dị đó, em cũng v", "em cũng v bán là nó bay múc chỉ", "em mua là chia 10 ảo ma"]}, {"post": "Kaito nay có tin gì mà tăng mạnh vậy ta. Pig mới unstake và giờ vẫn hold. Liệu nền tảng yap Kaito có quay trở lại không.", "replies": ["bơm thổi thôi", "bơm để xả đó", "chắc là hông rồi"]}, {"post": "Chào buổi sáng các builder X. Thứ 4 rực rỡ. Một tương tác nhỏ hôm nay có thể là cơ hội lớn mai sau. Đi ngang qua nhớ để lại lời chào.", "replies": ["chào bae nha, bsvv", "cố lên vì tương lai", "ngày  nào cũng rực rỡ hết"]}, {"post": "Anh em chơi crypto nên tạo thói quen cash out về VNĐ. Thanks Bitcoin lên 65k lại có chầu lẩu hải sản chua cay.", "replies": ["thị trường ảo quá rồi, lên xuống mà nản"]}, {"post": "GM CT", "replies": ["GM fen", "GM", "GM bạn nha"]}, {"post": "Chuyện gì đang xảy ra với Robinhood vậy anh em. Bắt đầu có vài dự án scam, dự án Noxa bị nghi ngờ rug cộng đồng. Anh em cẩn thận với meme hệ Robinhood, không rành thì tốt nhất đứng ngoài.", "replies": ["mùa này chỉ nên giữ tiền", "mùa này ưu tiên giữ tiền hơn đầu tư", "nào hết vol mạnh nên né"]}, {"post": "Mùa WC thức đêm nhiều mà mọi người vẫn cày đều đặn. Pig ban ngày vui vẻ nhưng đêm ngủ say, sáng dậy muộn rồi cuối kỳ lại kêu lương thấp.", "replies": ["nó random quá cũng lười cày", "pay ảo lắm mà phải cày đói quá", "sắp đến ngày pay rồi đã đã"]}, {"post": "Có ai thấy dạo này FL mỗi ngày vẫn tăng đều mà tổng Followers thì gần như đứng im không?", "replies": ["em cũng y chang vậy", "càng cao càng khó", "kệ đứng im cũng build"]}, {"post": "Tom Lee nói Ethereum là tài sản vĩ mô có hiệu suất tốt nhất trong thông báo CPI và gọi đó là bằng chứng ETH là tiền tệ. Khi sở hữu nhiều cái gì thì luôn cho rằng nó tốt nhất.", "replies": ["em fan cứng ETH đây", "hold con lùm ETH 4 năm rồi", "4 năm một tình yêu ETH"]}, {"post": "Vitalik vừa bị chê nhưng ETH đang kéo về 2000 đô, ai chê thì bị cà khịa ngược", "replies": ["lên 2k rồi chê tiếp", "CEO què gì bán miết", "biết nào lên cao"]}, {"post": "15 ngày trước, tài khoản này gần như là con số 0. Hôm nay có hơn 1 triệu lượt hiển thị, hơn 1.100 follower hoạt động và 7.100 lượt tương tác. Có ngày gần 600.000 impressions, có ngày chỉ vài nghìn nhưng quan trọng là không bỏ cuộc. Mục tiêu tiếp theo là 10.000 follower và xây dựng cộng đồng chất lượng.", "replies": ["mình xây 1 năm rưỡi mới được như hiện tại", "vì tương lai ước một lần viral", "em cũng đánh đổi dữ lắm"]}, {"post": "Hôm nay có 300 rep thôi. Hơi chán, nhưng bị tắt kiếm tiền thì như vậy cũng là cố gắng rồi. Khi nào được bật lại thì tăng năng suất x10.", "replies": ["tắt kiếm tiền thôi mà, xây to thì nhiều lợi hơn", "cố lên vì tương lai", "xây nữa xây mãi để mình gặp nhau mỗi ngày"]}, {"post": "Có người hỏi Linz thích gì nhất thì Linz khó trả lời chi tiết. Chỉ cần một bó hoa tươi cũng khiến Linz có thiện cảm và hạnh phúc. Lần đầu đi date cứ tặng hoa tươi, hoa sáp dù đẹp nhưng hoa tươi vẫn khiến chị em có nhiều thiện cảm hơn.", "replies": ["mình thì thích tiền thôi hahhhh", "con gái thích nhiều lắm", "em k thích hoa em thích thực tế"]}, {"post": "Thị trường xanh quá rồi. Liệu có uptrend chưa cả nhà. Mong tài khoản anh em đều xanh.", "replies": ["quá đủ rồi em chỉ ước là x10 thoi", "tài khoản còn đỏ tươi", "chỉ ước một lần xanh"]}, {"post": "Các mốc thời gian của nhà đầu tư: 8h30 hôm nay không FOMO, 9h30 chắc mua ít thôi, 10h30 full margin, 15h giá như.", "replies": ["cuộc đời không giá như đâu, xem phim tung của quá 180 phút nè", "giá như ngày đó k join crypto", "giá như k đụng crypto"]}, {"post": "Ngày đi phụ hồ được 500k. Oánh meme hết 1 củ rưỡi. Ai cứu tôi.", "replies": ["đanh đít giờ ở đó cứu", "ai cứu nổi bạn", "meme là niềm đau đó"]}, {"post": "$BTC hôm qua đóng với cây nến xanh. Hôm nay phản ứng nhẹ trước EMA50, kết hợp mô hình 2 đáy và mới phá đỉnh gần đó. Xác suất BTC tăng tiếp lên vùng 67xxx. Chờ điểm hồi đẹp là vào lệnh Long ở khung nhỏ, đây là ý kiến cá nhân không phải lời khuyên đầu tư.", "replies": ["xanh hay đỏ không phải phân tích chờ mõm vương bên kia châu lục lên tiếng", "đầu tư riết phải xem sắc mặt tổng thống", "mùa này ngày nào cũng tàu lượn"]}, {"post": "Nhiều người vẫn đang cố short ETH. Robinhood Chain nóng lên nhờ hệ meme, người chơi FOMO mua ETH để nạp tiền săn kèo ngày càng nhiều. Short sai nhịp có khi chưa kịp thấy ETH điều chỉnh đã thấy tài khoản bị thanh lý.", "replies": ["em ôm eth 4 năm rồi", "Em cũng fomo ngay đỉnh", "ước gì ngày đó không mua ETH"]}, {"post": "X bị làm sao thế. Nhiều bình luận khi kéo lên xem thì hiện cảnh báo. Không biết đó là cảnh báo gì hay tài khoản đang có vấn đề.", "replies": ["nhiều lúc thuật toán mệt lắm", "thuật toán ảo ma la da", "tình trạng chung rồi"]}, {"post": "Hình ảnh Dải Ngân Hà Milky Way chụp bằng S26 Ultra dùng APP Raw. Nhìn lại nhớ những năm đi ra ruộng cắm câu đêm và nhìn thấy Dải Ngân Hà nhưng lúc đó chưa biết nó là gì.", "replies": ["em thích bầu chời lắm", "điện thoại xịn chụp gì cũng đẹp", "nhớ những ngày lội ruộng"]}, {"post": "Nay mới được 35 follower mới, móm quá mọi người ơi. Khi nào mới đủ được 10k follow đây.", "replies": ["cố gắng thì mới được chứ sao, không khóc", "không khóc nè, chăm đi", "chăm chỉ lên coi"]}, {"post": "Khép lại một ngày dài. Dù hôm nay có nhiều niềm vui hay điều chưa trọn vẹn, hãy để muộn phiền lại phía sau. Chúc mọi người buổi tối bình yên, ngủ ngon, mơ đẹp và thức dậy nhiều năng lượng cho ngày mới.", "replies": ["em cũng chuẩn bị tắt máy", "vui vẻ thì mới có năng lượng tích cực", "ngày  nào cũng rực rỡ hết"]}, {"post": "GM cả nhà mình. Chúc tất cả một ngày mới nhiều sức khỏe và bình an. Vậy là đã đạt được một nửa điều kiện rồi, mong cả nhà ủng hộ phần còn lại.", "replies": ["cứ sáng mở mắt ra là dô X", "cứ vừa mở mắt là vô X check liền", "X là người yêu của em"]}, {"post": "Chào buổi sáng tất cả anh em. Chưa gì đã là thứ 5 rồi, hôm nay sẽ là đợt quét cuối cùng, sáng mai ai ngủ dậy vẫn còn xanh thì thứ 7 lụm tiền.", "replies": ["sắp tới ngày lụm tiền rồi", "sắp rồi sắp rồi", "hóng từng giây"]}, {"post": "GM CT. Dậy sớm để thành công nào mọi người ơi. Còn mình bắt đầu ngày mới tệ đến thế là cùng.", "replies": ["bắt đầu làm việc nào", "bạn phải cố gắng có gì đâu tệ", "Em đã dậy"]}, {"post": "Short ZEC đang âm hơn 12.000 đô mà vẫn chưa thấy cắt lỗ. Nhiều anh em rất liều hoặc vị thế đủ lớn để chịu được drawdown như thế này.", "replies": ["kiểu chày chối, còn thở còn gỡ", "còn thở là còn gồng", "gồng mạnh"]}, {"post": "BNB Chain vừa đốt hơn 1,6 triệu BNB, tương đương khoảng 932 triệu USD. Nguồn cung giảm đều theo từng quý trong khi hệ sinh thái vẫn mở rộng. Đợt burn này có đủ tạo sóng cho BNB không?", "replies": ["giảm thì ngon, ai như con què ETH", "BNB nhìn tương lai nhìn lại ETH chán", "CEO người ta thấy ham vitalik bán"]}, {"post": "Thứ mất thời gian nhất trên X này. À không, mất thời gian nhất trên đời luôn.", "replies": ["em thấy què gì cũng mất thời gian", "X là tương lai mất tg đâu", "X giàu sang mô phật"]}, {"post": "Dù bạn là ai, đang làm gì hay đến từ đâu, chỉ cần đang hoạt động trên X thì hãy cùng tương tác và kết nối với mình.", "replies": ["em sẵn sàng chiến x rồi", "Mở mắt là chiến mạnh", "chiến mỗi giờ luôn bạn ơi"]}, {"post": "Có ai thấy thứ 5 chỉ cần ăn sáng đúng món là cả ngày chạy mượt hơn không. Mình ăn phở gà thêm trứng non với phèo là đủ no đủ pin, tinh thần lên mood rồi chiến checklist.", "replies": ["nói chung sáng phải ăn sáng mới có tinh thần", "ăn để có sức", "lên mood là cào mạnh tay hé"]}, {"post": "Giao thức Liquidity Pool Vault của Ostium bị hack 23 triệu đô. Hacker tạo giao dịch giả khiến vault trả USDC rồi swap sang ETH. Sáng nay các bài về vụ hack trên X của Ostium đã bị xóa.", "replies": ["mía down cái tối ngày bị hack", "cố lên vì tương lai", "ngày  nào cũng rực rỡ hết"]}, {"post": "Ngày 16/09/2020, Uniswap tặng 400 UNI cho mọi ví từng sử dụng nền tảng. Lúc nhận trị giá khoảng 1.200 USD, đến ATH từng hơn 17.000 USD. Sự kiện này khiến thị trường bắt đầu săn airdrop nghiêm túc.", "replies": ["xưa cày ngon nhiêu giờ nịt bấy nhiêu", "xưa thở thôi cũng ra tiền", "nhìn lại chỉ biết giá như"]}, {"post": "Khi định đi uống trà sữa thư giãn nhưng thuật toán X cứ nhắc đăng bài và reply. Mỗi ngày lên X một chút, mỗi bài tốt hơn hôm qua một chút, kiên trì đủ lâu thuật toán sẽ nhớ đến bạn.", "replies": ["không lên X là ngứa ngáy hơn thèm trà sữa", "em full time x", "riết x là lẽ sống"]}, {"post": "Bạn không thể kiểm soát bất kỳ điều gì. Hãy bình thường hóa việc người ta lướt qua bài nếu đó không phải thứ họ muốn đọc, nhưng hãy tiếp tục viết vì đó là thứ duy nhất bạn có thể kiểm soát.", "replies": ["nói chung thì mọi việc phải suy nghĩ kĩ á", "đừng làm quá mọi việc là ok hà", "xui lúc đó ai nhập á bình tĩnh là okla ngay"]}, {"post": "Mục tiêu tháng 7 là lên 30k follower nhưng đi được nửa tháng mới lên tròn 27k. Lượng follower càng cao thì càng khó tăng, cứ đà này cuối năm khó lên nổi 100k.", "replies": ["em cũng thấy vậy, khó kinh", "mục tiêu em cũng v", "cào cháy máy đi lo gì"]}, {"post": "Xem lại video về Pi thấy thương các cụ từng tin một Pi bằng 7,2 tỷ VNĐ và sẽ thay đổi tiền tệ thế giới. Có người đổi cả xe để mua, giờ một Pi chỉ khoảng 0,8 đô.", "replies": ["quá khứ thì đúng, hiện tại thì không", "dự án què chơi lừa người già", "đợt 50k bán vội"]}, {"post": "Ra quán cà phê chợt nhận ra những bản nhạc quen thuộc ngày trước không còn được mở nữa. Cuộc sống lúc nào cũng thay đổi, những điều bình thường hôm nay rồi cũng sẽ thành điều mình nhớ nhất.", "replies": ["cuộc sống cứ trôi qua, hãy tận hưởng", "tự bắt nghe chứ mấy bác căng quá", "thay đổi theo thời đại nó dị đó"]}, {"post": "Sau nhiều ngày kháng cáo cuối cùng cũng nhận được mail phản hồi. Tiếp tục kháng thì vẫn còn cơ hội mở, còn bỏ cuộc thì coi như thôi.", "replies": ["em chả buồn kháng luôn", "thôi cứ xây to rồi tính", "cứ xây đi to rồi kháng"]}, {"post": "Một bữa sáng ngon còn quan trọng hơn báo thức. Thứ 5 được ăn tô bánh canh xắt da heo với huyết thì có thêm động lực đi làm, bụng no thì tinh thần cũng khác.", "replies": ["rõ ràng ăn mới có sức làm", "em còn chưa ăn đây nè", "đúng năng lượng cả ngày do bữa sáng đó"]}, {"post": "Chào ngày mới anh em. Bước sang nửa còn lại của cuối tuần, ngày mới nhiều năng lượng tích cực. Có ai giống con rắn này không?", "replies": ["nhìn sợ fen ơi", "chào ngày mới fen", "ngày mới tích cực nha"]}, {"post": "Đừng đợi đến khi hoàn hảo mới bắt đầu. Sự nghiệp là một quá trình, không phải một điểm đến.", "replies": ["đúng trao dồi mỗi ngày", "cái gì lên nhanh quá cũng không tốt", "cứ làm tới đâu xây tới đó"]}, {"post": "GM gia đình. Ăn sáng tử tế, uống cà phê đàng hoàng rồi chiến tiếp. Chúc anh em hôm nay nhiều kèo ngon và nhiều niềm vui.", "replies": ["bạn cũng vậy nhaaa", "no bụng rồi chiến", "mình với bạn bào mạnh tay nha"]}, {"post": "Hôm nay là thứ 5 rồi. Chúc anh em chăm chỉ để thứ 7 nhận lương ba con số.", "replies": ["em bị tắt rồi cũng hữu duyên", "cũng muốn được nhận mà lỏ", "tới ngày đó nhìn ngta khoe mà ước"]}, {"post": "GM mọi người. Hôm nay dựa vào yếu tố kỹ thuật, mình chờ nhịp điều chỉnh của RAVE và bắt đầu canh đánh lên. Ai quan tâm RAVE thì tương tác.", "replies": ["cẩn thận xíu  nha long short canh kĩ xíu", "long short như tàu lượn", "để mình nghía nó"]}, {"post": "Đây là chart của một token bất kỳ trên Robinhood hiện tại. Volume đang yếu dần và dòng vốn FOMO có vẻ đang hạ nhiệt.", "replies": ["dòng tiền ở đâu mình ở đó", "Vol yếu rồi ngó", "chờ thôi vol yếu giờ vô chua lè"]}, {"post": "Sau tất cả những gì xảy ra, mình xem đây là cơ hội làm lại từ đầu. Có ai từng bị pause hoặc reject monetization trên X rồi build lại thành công không, chia sẻ kinh nghiệm đăng bài, xóa bài cũ và kháng cáo.", "replies": ["cố lên x làm được nhiều cái mà", "xây x làm web 3 với mình", "Cứ xây cho mạnh đã"]}, {"post": "GM X fam. Thứ 5 rồi, chỉ còn hai ngày nữa đến payout. Mọi người đã sẵn sàng hay vẫn chờ cú bùng nổ phút cuối?", "replies": ["sẵn sàng rồi fen", "Chơi go go", "tới đó nhìn ngta khoe fen"]}, {"post": "Mùa tới cuộc đua meme sẽ gay cấn giữa Solana và Robinhood. Đây cũng là cuộc đua tăng giá giữa ETH và Solana, chain nào có meme active tốt hơn thì tăng cao hơn.", "replies": ["em vô eth giờ sụm nụ", "con lùm ETH miaaaa", "rồi nào tới meme ETH"]}, {"post": "Một bầu trời tuổi thơ của thế hệ 8x và 9x. Đây là món mà trạm dừng chân nào cũng có, mời mọi người tráng miệng buổi sáng.", "replies": ["em khoái bánh này vô cùng", "món ruột em", "em genz nhưng vẫn biết"]}, {"post": "Video này đủ chill chưa. KPI hôm nay là ngắm cá, ngâm nước và quên deadline hết ngày. Chúc cộng đồng Build X build nhiều giá trị nhưng đừng quên năng lượng cho mình.", "replies": ["giá trị update theo từng ngày", "dealine bỏ sau lưng đi", "lo gì chơi tới đi"]}, {"post": "Bây giờ đang là mùa thu. Câu thơ theo mùa cũng trở về. Chẳng ai tính tuổi mùa, tuổi yêu: chúng mình nhắm mắt đi em, cho na mở mắt ra xem chúng mình.", "replies": ["thơ hay người ơi", "em đáp lại được hông", "em khô khan k biết thơ"]}, {"post": "Dậy ăn sáng thôi cả nhà. Chuẩn bị đến kỳ Pay X tiếp theo rồi nên hôm nay Kyo ăn chay.", "replies": ["ăn chay s có sức cày", "không được pay là ăn chay hết tháng", "ăn chay cũng ngon ăn với"]}, {"post": "Buổi sáng thứ 5 vui vẻ. Mới đầu tuần mà giờ đã đến thứ 5 rồi, nếu không có gì thay đổi thì sáng thứ 7 lại thấy mình flex.", "replies": ["nhanh hết tuần quá chời", "mình buồn cũng ước được flex", "nghĩ tới ngày đó thôi chạnh lòng"]}, {"post": "Bốc vội nắm xôi rồi vào việc. Chúc anh em thứ 5 làm việc hết công suất.", "replies": ["nhìn là thèm rồi", "món ruột", "nhìn là muốn xách đít đi mua ăn liền"]}, {"post": "CASHCAT chia hai từ đỉnh và khả năng cao tiếp tục dò đáy trong những ngày tới. Hệ Robinhood cũng giảm nhiệt FOMO chỉ trong vài ngày, đúng hệ đưa tiền anh em ra đảo.", "replies": ["đâu có gì lên mãi được", "vô làm thanh khoản", "meme giờ vô là tàn canh"]}, {"post": "Cứ bình tĩnh mà sống, cứ nhiệt huyết mà làm. Chúc một ngày bình yên và nhiều thành quả. Chào buổi sáng cả nhà X.", "replies": ["bình tĩnh mà làm, không có gì phải vội rồi sai tè ra", "cứ từ từ k phải vội nó vẫn ở đó", "cuộc đời cứ vui là ưu tiên"]}, {"post": "Mình thấy gu thẩm mỹ này đang dẫn đầu xu hướng visual trên feed. Trong ba tháng tới các content creator sẽ bắt đầu chạy theo style tối giản này. Aesthetic.", "replies": ["cái gu này làm em choáng", "style này em em.....", "nhìn style thôi là thấy hưng phấn"]}, {"post": "Biển xanh vì biết ôm trời, em xinh vì biết làm người tương tư. Thèm đi biển, năm nay chưa được đi biển.", "replies": ["beach vibes cứ đỉnhh mãi thôi", "em thích biển màu xanh nó mát", "mấy năm k được đi biển ròi"]}, {"post": "Dù phụ nữ có tài giỏi, độc lập và kiếm tiền giỏi đến đâu, khi thiếu một người đàn ông đúng nghĩa bên cạnh thì vẫn phải một mình gánh những điều không ai nhìn thấy.", "replies": ["không có ai hoàn hảo cả", "phụ nữ thì vẫn là phái yếu mà", "như em em cũng cần có điểm tựa huhuuu"]}, {"post": "Lần đầu đạt ATH view tích xanh với 48k3 view. Với nhiều người đây là con số nhỏ nhưng với mình là cả hành trình xây dựng, lần pay tới tự tin ATH.", "replies": ["nhìn mà ao ước", "nhìn lại acc mình chán", "chúc mừng trước nhaaa"]}, {"post": "Thành công đến từ những buổi sáng không bỏ cuộc. Bún hải sản full topping là phần thưởng nhỏ cho những ngày cố gắng, cày ngày đêm trên X vì mục tiêu phía trước.", "replies": ["nhìn mà muốn nhào vô ăn liền", "nhìn thèm ăn online", "thứ 7 là biết đổi món sang hơn nhaaa"]}, {"post": "Hôm nay tiếp tục dí BILL, H và LAB, hy vọng mai có tiền cash out về VNĐ.", "replies": ["hi vọng mai là bữa hải sản ngon", "cứ húp là vnđ ăn ngon ngủ yên", "good luck nha vnđ muôn năm"]}, {"post": "Chào buổi sáng. Chúc cả nhà ngày mới tràn đầy năng lượng.", "replies": ["ngày mới năng lượng nha fen", "GM fen", "ngày  nào cũng rực rỡ hết nhaaa"]}, {"post": "Luis Phạm này là ai mà dạo này thấy lên top trending trên X vậy anh em?", "replies": ["ai đồ đó chời", "là ai mà viral mấy nay", "idol gì bên tíc tốc ấy"]}, {"post": "Morning, dậy đón nắng sớm. Hôm qua mọi người ngủ có ngon không, hy vọng hôm nay sẽ là một ngày dịu dàng với bạn.", "replies": ["ngày nào cũng dịu dàng hết", "dậy sớm cho khỏe ngừ", "ngủ siêu ngon"]}, {"post": "OP có được coi là kỳ lân công nghệ một thời không. Nhiều người đã đu ở mốc 2 đô, muốn cắt lỗ nhưng lại sợ bán xong nó bay, giờ thì đang đi vào lòng đất.", "replies": ["kì lân hay sống dưới lòng đất á hhhh", "nghe lời ai đồ nào đó", "sắp tat thở rồi"]}, {"post": "Thấy IBM rơi 25 phần trăm nên nhảy vào bắt đáy, ai ngờ sập thêm 9 phần trăm. Chứng Mỹ rơi còn căng hơn altcoin, công ty lớn mà chart đi như meme.", "replies": ["quá mệt mỏi với chart", "chứng khoán còn v coin nghĩa địa luôn", "ảo ma chứng khoán còn hơn meme"]}, {"post": "Hôm nay coin nào sẽ nhân tài khoản nào. Hệ Robinhood có vẻ sắp hẹo, người ta kiếm được tiền còn mình làm thanh khoản. Tiền chỉ chuyển từ túi người này sang người khác.", "replies": ["cuộc chơi này chỉ có mình làm thanh khoản thôi", "mình là thanh khoản béo của dev", "biết nào giàu khi fomo quài đây"]}, {"post": "Margin 3.5u và đang gồng lỗ 554u. LAB ngày nào cũng unlock token để xả thì khó đỡ chart, nên đợi dự án mới thay vì tiếp tục gồng.", "replies": ["Con này đi xa", "rồi sl đâu miaaaa", "ăn 10u để gồng nhiêu đó đô hả"]}, {"post": "Good morning, chào cả nhà ngày mới đầy năng lượng. Sắp pay rồi chắc mọi người căng thẳng, cứ chill vì mình còn chưa được bật kiếm tiền.", "replies": ["ăn sáng ở nơi quí tộc dị"]}, {"post": "Good Morning. Nắng sớm lên rồi, dậy đi nào các đồng chí. Chúc cả nhà một ngày nhiều niềm vui và năng lượng tích cực.", "replies": ["hello ngày mới fen", "em dậy rồi fen", "ngày mới rực rỡ nhaaa"]}, {"post": "Chào buổi sáng. Biết ơn cuộc sống và ông trời đã cho thêm một ngày mới tràn đầy năng lượng để cố gắng. Chúc cả nhà ngày mới hoan hỷ và may mắn.", "replies": ["còn mở mắt thấy ngày mới là ngon", "cũng cũng ok khi còn mở mắt", "ngày mới thành công nhaaa"]}, {"post": "Mục tiêu tháng 7 là đạt 5k bạn tích xanh, một triệu view đầu tiên và 600 reply mỗi ngày. Hơi khó nhưng tin rằng cố gắng mỗi ngày sẽ làm được.", "replies": ["làm việc gì cũng nên có mục tiêu", "việc khó việc nhỏ thì phải có kết hoạch fen", "em cào tới khuya ngày nào cũng v"]}, {"post": "Niềm tự hào của quân đội Mỹ một thời, pháo đài bay không thể xâm phạm giờ nằm một góc trên hồ Ngọc Hà. Ông cha ta rất kiên cường, anh dũng và mưu trí.", "replies": ["bờ cõi phải giữ mới hòa bình", "biết ơn ông cha", "ông cha xưa quá giỏi quá tài"]}, {"post": "Tình yêu có cũng được, không có cũng chẳng sao. Không có tiền mới có sao.", "replies": ["tiền là vạn năng mà", "rõ ràng tiền là tất cả", "tình yêu thì có cũng được k cũng được nhưng tiền phải có"]}, {"post": "Em dừng trước đây, thị trường lên xuống kiểu này theo dõi mất ngủ.", "replies": ["vô phúc mới chơi crypto", "ước bản thân k biết crypto", "em cũng cảm thấy hối hận quá"]}, {"post": "Chào buổi sáng thứ 5. Hãy viết thêm một bài, học thêm một điều, kết nối với một người và kiên nhẫn với thứ đang xây dựng. Trong crypto lợi nhuận đến rồi đi, trên X lượt xem lúc cao lúc thấp.", "replies": ["mỗi ngày là một kết nối mới", "mỗi ngày học bài mới", "crypto giờ ảo lắm k theo kịp"]}, {"post": "CASHCAT trên Robinhood chia hai từ ATH và gãy mốc 100M FDV. ROI không còn tốt, khả năng làm thanh khoản cao hơn kiếm lời, người thiếu kinh nghiệm nên tránh.", "replies": ["em thấy hết sóng bên đó rồi", "chạy đi hết vol rồi fen", "ai mới dô k nên dô meme"]}, {"post": "Ngồi trader mà lướt 𝕏 newfeed mà tàn gái không à\n\nDạo này con gái xuất hiện nhiều vậy sao tui anh làm việc nổi\n\nMộc lên như nấm vậy anh em\n\nEm nào real lên tiếng để a note lại", "replies": ["chị em là siêng nhất đấy", "con gái mà cái gì cũng siêng", "vừa trade vừa ngắm đã mà"]}, {"post": "Một thanh niên Việt Nam vừa trúng 99.99 BNB, tương đương khoảng 1,5 tỷ đồng, trong sự kiện kỷ niệm sinh nhật 9 năm của Binance.\n\nĐáng nói là ngay sau khi nhận thưởng, anh chàng tuyên bố:\n\n“Chính thức nghỉ chơi crypto!”\n\nĐúng kiểu kiếm đủ rồi rút lui trong vinh quang. Công nhận anh em Việt Nam mình nhiều người có vía may mắn thật sự.\n\nCho xin ít vía nào anh em ơi", "replies": ["ảo ma chin su này người nhà quá", "đổi đời dễ quá", "vía này như vietlot"]}, {"post": "chain robinhood end game chưa vậy anh em?\n\nsau 2 tuần thì mình lãi được nhiêu đây\n\nngười ta mua toàn x vài chục lần, còn mình buy là đỏ", "replies": ["hết vol rồi", "y chang em khác gì đâu miaaaa", "end rồi còn gì nữa đâu"]}, {"post": "hanks you a Si đã tài trợ buổi trưa\n\nĐúng là GOAT có khác\n\nNạp đạn còn có sức vô ca chiều m.n ơi\n\nE HUY TKT chứ vẫn còn nhiệt lắm", "replies": ["bắt đền đó làm em đói bụng", "em cũng v nhiệt mỗi ngày", "nạp calo để bào mạnh tay"]}, {"post": "Build X không có nghĩa là làm việc kiệt sức.\n\nNgười bền bỉ luôn biết khi nào cần nghỉ.\n\nMột bữa ăn đủ chất.\nMột chút vận động.\nMột khoảng thời gian để đầu óc được làm mới.\n\nNăng lượng cũng là tài sản.\n\nGiữ được năng lượng là giữ được khả năng tạo ra giá trị.", "replies": ["build x nhàn chán rảnh thì lướt bận thì thoi", "em thì tạo và xây mỗi ngày", "đúng năng lượng sức khỏe là vốn"]}, {"post": "Ăn kiểu này thường chấm gì chính (muối ớt chanh, mắm ruốc, hay sốt mayo bơ tỏi)? Hay là tự làm hết luôn?", "replies": ["muối ớt chanh nha", "hành với đậu phộng", "em thích muối ớt"]}, {"post": "Cụ này chắc là chân đi lạnh toát rồi!\nGồng ác thiệt chớ\nCòn không đặt stoploss luôn", "replies": ["chơi fu mà không sl cháy là quá xứng đáng", "sl để chưng", "gì chứ sl quan trọng top 1"]}, {"post": "Đây là mình của 10 năm về trước.\n\nVà đây là thành quả cố gắng của mình sau khi nhờ AI chỉnh sửa\n\nTập tành gì cho mệt giờ muốn sống ảo cứ nhờ AI thôi các bác nhỉ", "replies": ["ảo luôn", "AI giờ què gì cũng biết", "AI giờ bá"]}, {"post": "Làm việc cả buổi sáng rồi, cũng đến lúc gạt công việc qua 1 bên để tập trung bữa trưa cho ngon miệng\n\nAnh em đã cơm nước gì chưa, mời thưởng thức món Cơm tấm sườn trứng với mình nhé\n\nAnh em ngon miệng nàk", "replies": ["em ăn với", "em chưa ăn", "Anh làm em đói bắt đền"]}, {"post": "Good morning", "replies": ["GM", "GM fen", "GM bae"]}, {"post": "Có những câu hỏi mà con gái họ biết thừa câu trả lời rồi mà vẫn cứ thích hỏi để mình trả lời như vậy đó.\n\nThử trả lời lệch 1 cái xem… tới công chuyện liền!", "replies": ["thích được quan tâm hỏi han", "tại thích v á", "em cũng hay v"]}, {"post": "Đây là ly cafe mình tự pha, ly như ly bia\n\nChúc ae mai được pay x to như ly cafe của mình", "replies": ["mong là pay ngon", "lúa lúa", "1 nghìn ly cf hé"]}];

// Chọn ngẫu nhiên n mẫu trong kho NYX_OWNER_STYLE_SAMPLES rồi dựng thành 1 khối ví dụ few-shot
// để nhét vào system prompt của các luồng reply (gọi từ CẢ buildReplyStyleBlock lẫn
// buildOwnerReplyStyleBlock bên dưới) - mỗi lần gọi lại ra bộ ví dụ khác nhau (dùng shuffle
// rồi cắt n phần tử đầu) để AI không học vẹt 1 khuôn cố định, đồng thời nhắc rõ đây CHỈ để
// học giọng văn chứ không phải để chép lại.
function pickOwnerStyleFewShotBlock(n = 5) {
  if (!NYX_OWNER_STYLE_SAMPLES.length) return '';
  const picked = [...NYX_OWNER_STYLE_SAMPLES].sort(() => Math.random() - 0.5).slice(0, n);
  const examplesText = picked.map((s, i) => {
    const repliesText = s.replies.map((r) => `  - "${r}"`).join('\n');
    return `Bài đăng mẫu ${i + 1}: "${s.post}"\nCác reply mẫu (văn phong tham khảo):\n${repliesText}`;
  }).join('\n\n');
  return `VÍ DỤ PHONG CÁCH THỰC TẾ (chỉ để HỌC giọng văn - ngắn gọn, đời thường, tiếng Việt cộng đồng crypto/Web3 - TUYỆT ĐỐI KHÔNG copy nguyên văn hay chỉ sửa vài chữ từ các ví dụ dưới, các ví dụ này có thể chẳng liên quan gì tới comment đang trả lời, PHẢI viết reply MỚI hoàn toàn bám đúng nội dung comment thật đang xử lý, chỉ mượn giọng văn/độ dài/cách dùng từ):\n\n${examplesText}`;
}

// Khối phong cách cho luồng Reply Comment (vai chủ bài đăng).
function buildOwnerReplyStyleBlock(tone, lengthInstruction, styleInstruction) {
  const parts = [getReplyToneGuide(tone), pickOwnerReplyAngle()];
  if (lengthInstruction) parts.push(lengthInstruction);
  if (styleInstruction) parts.push(`PHONG CÁCH RIÊNG do người dùng chỉ định (ưu tiên cao, áp dụng đè lên phần giọng ở trên): ${styleInstruction}`);
  parts.push(OWNER_REPLY_GUIDE);
  const fewShotBlock = pickOwnerStyleFewShotBlock();
  if (fewShotBlock) parts.push(fewShotBlock);
  return parts.join('\n\n');
}

// Độ dài: ô cấu hình cũ mặc định gợi ý 5-25 từ, hơi dài so với reply người thật (rất
// nhiều reply thật chỉ 3-6 từ). Nới cận dưới xuống 3 và nói rõ ngắn hơn cũng được.
// ============== GIỚI HẠN SỐ TỪ REPLY - ÉP CỨNG BẰNG CODE ==============
// LỖI CŨ: số từ Tối thiểu/Tối đa chỉ là "gợi ý" nằm trong prompt (ghi rõ "KHÔNG phải chỉ
// tiêu", "ngắn hơn/dài hơn vẫn được") và sanitizeReplyText chỉ cắt theo 300 KÝ TỰ - không
// hề đếm từ. Model bị kéo dài ra bởi khối phong cách/ví dụ mẫu dài -> đặt 8-10 từ vẫn ra
// reply dài. NAY: đếm từ thật sau khi AI trả lời; sai giới hạn thì bắt AI viết lại (tối đa
// 3 lượt), vẫn vượt thì cắt cứng đúng số từ tối đa.
function parseWordLimit(v) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeWordRange(wordMin, wordMax) {
  let min = parseWordLimit(wordMin);
  let max = parseWordLimit(wordMax);
  if (min && max && min > max) [min, max] = [max, min];
  return { min, max };
}

const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

// Tiếng Việt/Anh: đếm theo khoảng trắng (mỗi âm tiết tiếng Việt = 1 từ, đúng cách người
// dùng đếm). Tiếng Trung/Nhật/Hàn không có khoảng trắng: quy ước 2 ký tự = 1 từ.
function countReplyWords(text) {
  const t = String(text || '');
  const cjkCount = (t.match(new RegExp(CJK_CHAR_RE.source, 'g')) || []).length;
  const rest = t.replace(new RegExp(CJK_CHAR_RE.source, 'g'), ' ');
  const tokens = rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return tokens + Math.ceil(cjkCount / 2);
}

// Cắt cứng còn tối đa `max` từ; ưu tiên dừng ở cuối câu nếu vẫn giữ >= 60% số từ tối đa.
function truncateToWordLimit(text, max) {
  const t = String(text || '').trim();
  if (!max || countReplyWords(t) <= max) return t;
  let used = 0;
  let cut = 0;
  const re = /\S+/g;
  let m;
  while ((m = re.exec(t))) {
    const w = countReplyWords(m[0]);
    if (used + w <= max) {
      used += w;
      cut = m.index + m[0].length;
      continue;
    }
    if (CJK_CHAR_RE.test(m[0])) {
      const room = (max - used) * 2;
      if (room > 0) cut = m.index + Math.min(room, m[0].length);
    }
    break;
  }
  let out = t.slice(0, cut).trim();
  const sentence = out.match(/^([\s\S]*[.!?。！？…])[^.!?。！？…]*$/);
  if (sentence && countReplyWords(sentence[1]) >= Math.ceil(max * 0.6)) out = sentence[1].trim();
  return out.replace(/[\s,;:，；：\-–]+$/, '').trim();
}

// aiCall(systemPrompt, userMessage) -> Promise<string thô>. Trả về reply đã sanitize và
// nằm trong giới hạn số từ (nếu người dùng có cài đặt).
async function generateReplyWithinWordLimit(systemPrompt, userMessage, wordMin, wordMax, aiCall) {
  const { min, max } = normalizeWordRange(wordMin, wordMax);
  if (!min && !max) return sanitizeReplyText(await aiCall(systemPrompt, userMessage));

  const rangeLabel = min && max
    ? `${min}-${max} từ (TUYỆT ĐỐI KHÔNG quá ${max} từ)`
    : max ? `tối đa ${max} từ` : `tối thiểu ${min} từ`;
  const reminder = `\n\nGIỚI HẠN SỐ TỪ (BẮT BUỘC, ưu tiên cao nhất, đè lên mọi phong cách/ví dụ mẫu ở trên): reply phải dài ${rangeLabel}, đếm theo từ cách nhau bằng dấu cách. Viết 1 câu gọn, bỏ lời mở đầu và phần giải thích thừa.`;

  let last = '';
  let prompt = systemPrompt + reminder;
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = sanitizeReplyText(await aiCall(prompt, userMessage));
    last = text;
    const n = countReplyWords(text);
    const tooLong = !!max && n > max;
    const tooShort = !!min && n < min;
    if (!tooLong && !tooShort) return text;
    prompt = systemPrompt + reminder +
      `\n\nBẢN VIẾT TRƯỚC BỊ TỪ CHỐI: "${text}" có ${n} từ, ${tooLong ? 'VƯỢT' : 'THIẾU'} so với ${rangeLabel}. Viết lại bản KHÁC, ${tooLong ? 'rút gọn mạnh' : 'đủ ý hơn một chút'}, đúng ${rangeLabel}.`;
  }
  // Hết lượt thử: quá dài thì cắt cứng; quá ngắn thì chấp nhận (ngắn không gây hại).
  return max ? truncateToWordLimit(last, max) : last;
}

function buildReplyLengthInstruction(wordMin, wordMax) {
  const { min, max } = normalizeWordRange(wordMin, wordMax);
  if (!min && !max) return 'ĐỘ DÀI: 1 câu, càng ngắn càng tốt. 3-6 từ là hoàn toàn ổn. Tối đa khoảng 25 từ.';
  if (min && max) return `ĐỘ DÀI BẮT BUỘC: ${min}-${max} từ (đếm theo từ cách nhau bằng dấu cách). TUYỆT ĐỐI KHÔNG vượt quá ${max} từ - vượt là bị loại và phải viết lại. Viết 1 câu gọn, bỏ mọi phần thừa.`;
  if (max) return `ĐỘ DÀI BẮT BUỘC: tối đa ${max} từ. TUYỆT ĐỐI KHÔNG vượt quá ${max} từ. Viết 1 câu gọn.`;
  return `ĐỘ DÀI: tối thiểu ${min} từ, 1 câu gọn, không lan man.`;
}

// Chỉ dùng cho bài đăng dài (Tạo Content) - KHÔNG dùng cho reply ngắn 1 câu.
const NATURAL_PARAGRAPH_INSTRUCTION = `Trình bày: chia thành các đoạn ngắn tự nhiên, MỖI ĐOẠN CHỈ 1 CÂU NGẮN, các đoạn cách nhau bằng 1 dòng trống, thay vì viết dồn thành 1 khối văn bản dài liền mạch - giống cách một người thật soạn bài đăng mạng xã hội. TUYỆT ĐỐI KHÔNG đặt dấu chấm (.) hay dấu phẩy (,) ở CUỐI câu/cuối đoạn, kể cả câu đầu tiên của bài (ví dụ minh hoạ quy tắc, KHÔNG phải mẫu để chép lại nguyên văn: "[Câu mở đầu bất kỳ]" viết không có dấu phẩy ở cuối; "[Một câu bất kỳ]" viết không có dấu chấm ở cuối). Cuối câu để trống, hoặc chỉ dùng "!" / "?" khi thật sự cần; dấu phẩy vẫn dùng bình thường Ở GIỮA câu. Dòng trống giữa các đoạn KHÔNG tính vào giới hạn ký tự (chỉ đếm ký tự chữ thực tế) - đây là yêu cầu BẮT BUỘC, ưu tiên ngang với giới hạn ký tự, không được hy sinh bố cục để bám đúng số ký tự. Tuyệt đối không dùng bullet, gạch đầu dòng hay tiêu đề in đậm để chia mục. TUYỆT ĐỐI KHÔNG dùng cụm "Hey everyone", "Hey guys", "Hi everyone" hay bất kỳ câu chào/câu mở đầu rập khuôn, cố định nào - mỗi bài phải có cách vào bài (câu đầu tiên) khác nhau, không lặp lại ý tưởng hay cấu trúc mở đầu của các bài trước đó.`;

// Bài tham khảo quét trực tiếp từ tài khoản DỰ ÁN (không qua KOL) là bài do CHÍNH dự án
// đăng nên đầy đủ đại từ ngôi thứ nhất của dự án ("chúng tôi", "we", "our"...). Người
// dùng là người sáng tạo nội dung độc lập, KHÔNG thuộc dự án -> AI phải đổi sang ngôi
// thứ ba khi nói về dự án, không được nhận việc của dự án là việc của mình.
function buildProjectPerspectiveInstruction(projectUser) {
  return `GÓC NHÌN NGƯỜI VIẾT (RẤT QUAN TRỌNG): Bài tham khảo là bài do CHÍNH tài khoản dự án @${projectUser} đăng, nên các từ "chúng tôi", "chúng mình", "we", "our", "us" trong đó là ĐỘI NGŨ DỰ ÁN. Còn bạn là 1 người sáng tạo nội dung ĐỘC LẬP, KHÔNG thuộc dự án, không phải thành viên hay đại diện của dự án. TUYỆT ĐỐI KHÔNG dùng ngôi thứ nhất (tôi, mình, chúng tôi, chúng mình, I, we, our) để nói về hành động, sản phẩm, thành tựu, kế hoạch hay thông báo của dự án. Phải chuyển sang ngôi thứ ba: gọi là "dự án", "team", "họ" hoặc @${projectUser}. Ví dụ: "Chúng tôi vừa ra mắt X" -> "Team vừa ra mắt X" hoặc "@${projectUser} vừa ra mắt X"; "Chúng tôi đang xây dựng Y" -> "Họ đang xây dựng Y". Ngôi "tôi/mình" CHỈ dùng cho quan điểm, nhận định, cảm nhận cá nhân của người viết (ví dụ "mình thấy hướng đi này khá thú vị"), không dùng để nhận việc của dự án. Lời kêu gọi hành động (CTA) cũng phải đổi góc nhìn, ví dụ "Hãy tham gia cùng chúng tôi" -> "Ai quan tâm có thể theo dõi @${projectUser}", không nói như thể mình đang đại diện dự án.`;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Áp dụng giao diện sáng/tối đã lưu NGAY từ đầu (trước khi dựng các phần khác)
  // để tránh nhấp nháy sai giao diện lúc mở lại panel.
  const { uiTheme } = await chrome.storage.local.get('uiTheme');
  applyTheme(uiTheme || 'dark');
  setupThemeToggle();

  const navBtns = document.querySelectorAll('.tab-bar .tab-btn');
  const tabContents = document.querySelectorAll('.main-content .tab-content');

  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      navBtns.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.getAttribute('data-tab')).classList.add('active');
    });
  });

  document.querySelectorAll('.sub-tab-bar').forEach((bar) => {
    const btns = bar.querySelectorAll('.sub-tab-btn');
    btns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-subtab');

        if (btn.classList.contains('sub-sub-btn')) {
          const parent = bar.parentElement;
          parent.querySelectorAll('.subsubtab-content').forEach((st) => {
            st.classList.toggle('active', st.id === targetId);
          });
        } else {
          const parentSection = bar.closest('.tab-content') || bar.parentElement;
          parentSection.querySelectorAll(':scope > .subtab-content').forEach((st) => {
            st.classList.toggle('active', st.id === targetId);
          });
        }
      });
    });
  });

  // Accordion (Tiện Ích) - bấm vào tiêu đề để mở tiện ích đó, các tiện ích khác tự đóng lại
  document.querySelectorAll('.accordion-header').forEach((header) => {
    header.addEventListener('click', () => {
      const item = header.closest('.accordion-item');
      if (!item) return;
      const wasOpen = item.classList.contains('open');
      const siblings = item.parentElement.querySelectorAll(':scope > .accordion-item');
      siblings.forEach((sib) => sib.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  setupChipGroups();
  setupContentSourceToggle();
  await setupRestInteractionSettings();
  setupAiProviderToggle();
  setupPostModeToggle();
  setupScheduleRepeatDailyToggle();
  initSelectCollapseGroups();
  projectTagInput = setupTagInput('scanProjectInput', 'projectTagList', 'projectTags', { selectable: true, single: true });
  kolTagInput = setupTagInput('scanKolInput', 'kolTagList', 'kolTags', { selectable: true }); // chọn được NHIỀU KOL - quét thử lần lượt, KOL đầu không có bài thì chuyển KOL kế tiếp

  await loadSavedState();
  syncSelectTriggerLabels();
  startPcClock();
  await refreshScheduledPostsList();
  await flushScheduledPostLog();
  document.getElementById('btnClearFinishedSchedules').addEventListener('click', clearFinishedSchedules);
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // background.js báo tiến độ khi đang thử lần lượt nhiều KOL (KOL đầu không có bài tag dự án
    // -> chuyển KOL kế tiếp) trong luồng Tạo Content thủ công.
    if (request && request.action === 'KOL_FALLBACK_PROGRESS') {
      const genStatus = document.getElementById('generateStatusText');
      if (genStatus && request.level !== 'error') genStatus.innerText = `\u{23F3} ${request.text}`;
      logEvent('create', request.text, request.level || 'info');
    }
    // background.js báo tiến độ Content Crypto (cả khi chạy tự động theo giờ).
    if (request && request.action === 'CRYPTO_STATUS') {
      setCryptoStatus(request.text);
      flushScheduledPostLog();
    }
    // background.js báo tiến độ quét ChatGPT (cả khi chạy tự động theo giờ).
    if (request && request.action === 'CHATGPT_STATUS') {
      setChatgptStatus(request.text);
      flushScheduledPostLog();
    }
    // background.js báo tiến độ 1 Nhiệm vụ đang chạy (theo giờ hẹn hoặc "Chạy thử ngay").
    if (request && request.action === 'MISSION_STATUS') {
      const card = document.querySelector(`.mission-card[data-id="${request.missionId}"]`);
      const statusEl = card?.querySelector('.m-status');
      if (statusEl) statusEl.innerText = request.text;
      // Nút Chạy/Dừng giờ theo trạng thái "đang chạy liên tục" (không đổi theo từng lượt đăng).
      flushScheduledPostLog();
    }
    if (request && request.action === 'SCHEDULED_POST_UPDATED') {
      flushScheduledPostLog();
      refreshScheduledPostsList();
    }
    // background.js báo tới giờ hẹn đăng bài - tạm dừng Tương tác Home đang chạy để không
    // thao tác trên tài khoản X song song với luồng tạo + đăng bài.
    if (request && request.action === 'PAUSE_ALL_FOR_SCHEDULE') {
      pauseAllFlowsForSchedule();
      // TRẢ LỜI (ACK) cho background.js biết panel đã nhận + đã tắt cờ các vòng lặp, thay vì
      // để background bắn 1 message rồi chạy tiếp ngay mà không biết panel có nghe hay không.
      try { sendResponse({ ack: true }); } catch (e) {}
      return true;
    }
    // background.js báo bài hẹn giờ đã chạy xong - tính năng nào bị tạm dừng vì lý do đó
    // (không phải do người dùng tự bấm Dừng) thì tự động chạy tiếp.
    if (request && request.action === 'RESUME_ALL_AFTER_SCHEDULE') {
      resumeAllFlowsAfterSchedule();
    }
  });

  TEXT_AUTOSAVE_FIELDS.forEach(([id, key]) => bindAutosaveField(id, key));
  SELECT_AUTOSAVE_FIELDS.forEach(([id, key]) => bindAutosaveSelect(id, key));
  bindHomeInteractLikeToggle();
  bindCrossLinkLikeToggle();
  bindCryptoControls();
  bindChatgptControls();
  bindMissionsList();
  bindHomeInteractControls();
  setupScrollTopButton();

  document.getElementById('btnGenerateContent').addEventListener('click', generateContentAI);
  document.getElementById('btnGenerateContentSchedule')?.addEventListener('click', generateContentAI);
  document.getElementById('btnStopGenerate').addEventListener('click', stopGeneration);

  // Mọi nút Chạy/Dừng đều gọi cancelScheduleResume trước: thao tác tay của người dùng
  // luôn thắng việc tự-tiếp-tục-sau-bài-hẹn-giờ (không bao giờ tự chạy đè lên quyết định
  // vừa bấm Dừng, cũng không chạy 2 lượt chồng nhau khi người dùng tự bấm Chạy lại).
  document.getElementById('btnRunHomeInteract').addEventListener('click', () => { cancelScheduleResume('homeInteract'); runHomeInteractFlow(); });
  document.getElementById('btnStopHomeInteract').addEventListener('click', () => { cancelScheduleResume('homeInteract'); stopHomeInteractFlow(); });

  setupMediaUploads();
  await restoreMediaGalleries();
  setupManualAnalysisImage();

  renderAllLogs();
  bindLogClearButtons();
});

// ============== GIAO DIỆN SÁNG / TỐI ==============
function applyTheme(theme) {
  const resolved = theme === 'light' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', resolved);
  const icon = document.getElementById('themeToggleIcon');
  if (icon) icon.textContent = resolved === 'light' ? '\u{2600}\uFE0F' : '\u{1F319}';
}

function setupThemeToggle() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const current = document.body.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    await chrome.storage.local.set({ uiTheme: next });
    showSavedToast(next === 'light' ? 'Đã chuyển giao diện sáng' : 'Đã chuyển giao diện tối');
  });
}

// ============== TOAST "ĐÃ LƯU" ==============
function showSavedToast(message = 'Đã lưu') {
  const toast = document.getElementById('autosaveToast');
  if (!toast) return;
  clearTimeout(toastHideTimer);
  toast.innerText = `\u{2713} ${message}`;
  toast.classList.add('show');
  toastHideTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1800);
}

// Nhật ký riêng của tab SETTING: ghi lại mỗi khi đổi 1 cài đặt. KHÔNG in giá trị API key ra log.
const SETTINGS_LOG_FIELDS = {
  openaiKey: { label: 'OpenAI API Key', secret: true },
  geminiKey: { label: 'Gemini API Key', secret: true },
  deepseekKey: { label: 'DeepSeek API Key', secret: true },
  typingSpeedMin: { label: 'Tốc độ gõ chữ - nhanh nhất (ms/ký tự)' },
  typingSpeedMax: { label: 'Tốc độ gõ chữ - chậm nhất (ms/ký tự)' },
  aiModel: { label: 'Model OpenAI' },
  geminiModel: { label: 'Model Gemini' },
  deepseekModel: { label: 'Model DeepSeek' },
};
const MEDIA_LOG_LABELS = { logoLibrary: 'Logo dự án', charLibrary: 'Nhân vật / Mascot', mediaLibrary: 'Thư viện ảnh có sẵn' };

function logSettingChange(key, shownValue) {
  const f = SETTINGS_LOG_FIELDS[key];
  if (!f) return; // field này không thuộc tab SETTING (vd cài đặt của Tạo Content/Chéo Link)
  if (f.secret) logEvent('settings', shownValue ? `Đã lưu ${f.label}.` : `Đã xoá ${f.label}.`, shownValue ? 'success' : 'info');
  else logEvent('settings', `Đã đổi ${f.label}: ${shownValue || '(để trống)'}`, 'info');
}

function bindAutosaveField(id, key, { debounceMs = 500 } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  let t = null;
  el.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      await chrome.storage.local.set({ [key]: el.value });
      showSavedToast();
      logSettingChange(key, el.value.trim());
    }, debounceMs);
  });
}

function bindAutosaveSelect(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', async () => {
    await chrome.storage.local.set({ [key]: el.value });
    showSavedToast();
    logSettingChange(key, el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : el.value);
  });
}

// ============== TOGGLE "LIKE SAU KHI REPLY" (Reply AI / Tương tác Home) ==============
function bindCrossLinkLikeToggle() {
  const toggle = document.getElementById('crossLinkLikeToggle');
  if (!toggle) return;
  toggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ crossLinkLikeAfterReply: toggle.checked });
    showSavedToast(toggle.checked ? 'Đã bật Like sau khi reply' : 'Đã tắt Like sau khi reply');
  });
}

function bindHomeInteractLikeToggle() {
  const toggle = document.getElementById('homeInteractLikeToggle');
  if (!toggle) return;
  toggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ homeInteractLikeAfterReply: toggle.checked });
    showSavedToast(toggle.checked ? 'Đã bật Like sau khi reply' : 'Đã tắt Like sau khi reply');
  });
}

// ============== NÚT CUỘN LÊN ĐẦU TRANG ==============
// Nút tròn cố định ở góc dưới bên phải, nằm ngay trên thanh tab. Chỉ hiện khi đã cuộn xuống quá 250px;
// bấm vào thì cuộn mượt thẳng lên đầu trang (đỡ phải kéo ngược lâu ở các tab dài).
function setupScrollTopButton() {
  const btn = document.getElementById('btnScrollTop');
  if (!btn) return;
  const tabBar = document.querySelector('.tab-bar');

  const updatePosition = () => {
    btn.style.bottom = `${(tabBar ? tabBar.offsetHeight : 64) + 12}px`;
  };
  const updateVisibility = () => {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    btn.classList.toggle('show', y > 250);
  };

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  window.addEventListener('scroll', updateVisibility, { passive: true });
  window.addEventListener('resize', updatePosition);
  // Đổi tab -> chiều cao trang đổi, cập nhật lại trạng thái hiện/ẩn của nút.
  document.querySelectorAll('.tab-bar .tab-btn').forEach((b) => b.addEventListener('click', () => setTimeout(updateVisibility, 50)));
  updatePosition();
  updateVisibility();
}

// Đọc 1 ô nhập số: để trống hoặc gõ chữ/số âm/vượt quá giới hạn đều tự hiểu về 0 hoặc kẹp
// lại trong khoảng hợp lệ, thay vì lưu giá trị rác hay NaN.
function readNumberInput(id, min, max) {
  const raw = document.getElementById(id)?.value;
  let n = parseInt(raw, 10);
  if (isNaN(n)) n = 0;
  return Math.min(Math.max(n, min), max);
}

function setupContentSourceToggle() {
  const chips = document.querySelectorAll('.chip[data-group="contentSource"]');
  const projectGroup = document.getElementById('projectScanGroup');
  const manualGroup = document.getElementById('manualTopicGroup');
  const tagTargetGroup = document.getElementById('tagTargetGroup');
  chips.forEach((chip) => chip.addEventListener('click', () => {
    const val = getActiveChipValue('contentSource');
    projectGroup.classList.toggle('hidden', val !== 'project');
    manualGroup.classList.toggle('hidden', val !== 'manual');
    if (tagTargetGroup) tagTargetGroup.classList.toggle('hidden', val !== 'project');
  }));
}

function setupPostModeToggle() {
  const chips = document.querySelectorAll('.chip[data-group="postMode"]');
  const scheduleGroup = document.getElementById('scheduleTimeGroup');
  chips.forEach((chip) => chip.addEventListener('click', () => {
    const val = getActiveChipValue('postMode');
    if (scheduleGroup) scheduleGroup.classList.toggle('hidden', val !== 'schedule');
    if (val === 'schedule') ensureScheduleDefault();
  }));
}

// Chỉ hiện dòng giải thích "chống trùng nội dung" khi người dùng thực sự bật lặp lại
// hàng ngày - tránh rối giao diện với người chỉ hẹn giờ đăng 1 lần.
function setupScheduleRepeatDailyToggle() {
  const toggle = document.getElementById('scheduleRepeatDailyToggle');
  const hint = document.getElementById('scheduleRepeatDailyHint');
  if (!toggle || !hint) return;
  toggle.addEventListener('change', () => {
    hint.style.display = toggle.checked ? '' : 'none';
  });
}

// ============== HẸN GIỜ ĐĂNG BÀI ==============
// Đổ dữ liệu cho 5 ô dropdown (Tháng/Ngày/Năm/Giờ/Phút) - chỉ chạy 1 lần.
// Số ngày trong tháng tự cập nhật lại khi đổi Tháng hoặc Năm (tránh chọn 31/2).
function populateScheduleSelects() {
  const monthSel = document.getElementById('scheduleMonthSelect');
  const daySel = document.getElementById('scheduleDaySelect');
  const yearSel = document.getElementById('scheduleYearSelect');
  if (!monthSel || monthSel.dataset.populated) return;

  monthSel.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">Tháng ${i + 1}</option>`).join('');

  const thisYear = new Date().getFullYear();
  yearSel.innerHTML = [thisYear, thisYear + 1, thisYear + 2].map((y) => `<option value="${y}">Năm ${y}</option>`).join('');

  // Giờ/Phút giờ là input số (không còn dropdown) - không cần đổ <option> nữa.

  function refreshDayOptions() {
    const y = parseInt(yearSel.value, 10);
    const m = parseInt(monthSel.value, 10);
    const daysInMonth = new Date(y, m, 0).getDate();
    const prevDay = parseInt(daySel.value, 10) || 1;
    daySel.innerHTML = Array.from({ length: daysInMonth }, (_, d) => `<option value="${d + 1}">Ngày ${d + 1}</option>`).join('');
    daySel.value = Math.min(prevDay, daysInMonth);
  }
  monthSel.addEventListener('change', refreshDayOptions);
  yearSel.addEventListener('change', refreshDayOptions);
  refreshDayOptions();

  monthSel.dataset.populated = '1';
}

function setScheduleSelectsToDate(date) {
  document.getElementById('scheduleYearSelect').value = date.getFullYear();
  document.getElementById('scheduleMonthSelect').value = date.getMonth() + 1;
  document.getElementById('scheduleMonthSelect').dispatchEvent(new Event('change')); // dựng lại số ngày trong tháng trước khi set Ngày
  document.getElementById('scheduleDaySelect').value = date.getDate();
  document.getElementById('scheduleHourSelect').value = date.getHours();
  document.getElementById('scheduleMinuteSelect').value = date.getMinutes();
}

// Lần đầu chuyển sang "Hẹn giờ đăng", tự điền sẵn mốc giờ hiện tại + 5 phút cho tiện,
// những lần sau giữ nguyên lựa chọn người dùng đã chọn (không tự ghi đè nữa).
function ensureScheduleDefault() {
  populateScheduleSelects();
  const yearSel = document.getElementById('scheduleYearSelect');
  if (yearSel && !yearSel.dataset.initialized) {
    setScheduleSelectsToDate(new Date(Date.now() + 5 * 60 * 1000));
    yearSel.dataset.initialized = '1';
  }
}

function getScheduledDateFromSelects() {
  const y = parseInt(document.getElementById('scheduleYearSelect').value, 10);
  const m = parseInt(document.getElementById('scheduleMonthSelect').value, 10);
  const d = parseInt(document.getElementById('scheduleDaySelect').value, 10);
  if ([y, m, d].some((n) => isNaN(n))) return null;
  const h = readNumberInput('scheduleHourSelect', 0, 23);
  const mi = readNumberInput('scheduleMinuteSelect', 0, 59);
  return new Date(y, m - 1, d, h, mi, 0, 0);
}

// Chỉ hiển thị giờ thực của máy, cập nhật theo từng giây (không đụng vào lựa chọn của người dùng).
function startPcClock() {
  const clockEl = document.getElementById('currentPcTimeText');
  function tick() {
    const now = new Date();
    if (clockEl) clockEl.innerText = `\u{1F552} Giờ hiện tại trên máy: ${now.toLocaleString('vi-VN')}`;
  }
  tick();
  setInterval(tick, 1000);
}

async function refreshScheduledPostsList() {
  const listEl = document.getElementById('scheduledPostsList');
  if (!listEl) return;
  const posts = await new Promise((res) => chrome.runtime.sendMessage({ action: 'GET_SCHEDULED_POSTS' }, (resp) => res(resp && resp.success ? resp.posts : [])));

  if (!posts || posts.length === 0) {
    listEl.innerHTML = '<div class="log-empty">Chưa có bài nào được hẹn giờ.</div>';
    return;
  }

  listEl.innerHTML = posts.map((p) => {
    const timeStr = new Date(p.scheduledTime).toLocaleString('vi-VN');
    const repeatBadge = p.repeatDaily ? ' <span class="hint-text">🔁 Lặp lại hàng ngày</span>' : '';
    const timeCaption = p.repeatDaily ? 'Lần đăng tiếp theo' : '';
    let preview;
    if (p.contentText) {
      // Đã có nội dung thật (bài đã đăng, hoặc đăng lỗi nhưng vẫn kịp tạo xong nội dung).
      // Với lịch lặp lại, đây luôn là nội dung của LẦN CHẠY GẦN NHẤT (không phải bài sắp
      // đăng tiếp theo - bài đó chỉ được tạo đúng lúc tới giờ, xem generateContentFromRecipe).
      const rawText = p.contentText || '';
      preview = escapeHtml(rawText.slice(0, 70)) + (rawText.length > 70 ? '…' : '');
    } else if (p.recipe) {
      // CHƯA tới giờ hẹn nên CHƯA có nội dung thật (nội dung chỉ được tạo đúng lúc alarm
      // bắn) - hiện tạm mô tả cấu hình sẽ dùng để tạo bài lúc đó.
      const r = p.recipe;
      preview = r.contentSource === 'project'
        ? `Dự án: ${escapeHtml((r.projectUsers || []).map((u) => `@${u}`).join(', '))}${r.kolUsers && r.kolUsers.length > 0 ? ` (qua ${escapeHtml(r.kolUsers.map((u) => `@${u}`).join(', '))})` : ''}`
        : `Chủ đề: ${escapeHtml(r.topic || '')}`;
    } else {
      preview = '';
    }
    let statusLabel = '\u{23F3} Chờ đăng (sẽ tạo nội dung đúng lúc tới giờ)';
    let levelClass = 'info';
    if (p.repeatDaily && p.lastRunAt) {
      // Lịch lặp lại: status luôn là 'pending' (đang chờ lần kế tiếp) - hiển thị kết quả
      // LẦN CHẠY GẦN NHẤT (lastRunStatus) thay vì coi như đã xong hẳn như bài hẹn 1 lần.
      const lastRunTimeStr = new Date(p.lastRunAt).toLocaleString('vi-VN');
      if (p.lastRunStatus === 'posted') {
        statusLabel = `\u{2705} Đã đăng lần gần nhất lúc ${lastRunTimeStr}${p.imageError ? ' (không kèm được ảnh)' : ''} - đã chạy ${p.runCount || 0} lần`;
        levelClass = 'success';
      } else {
        statusLabel = `\u{274C} Lần gần nhất (${lastRunTimeStr}) bị lỗi: ${escapeHtml(p.error || 'không rõ lỗi')} - vẫn tự chạy lại vào lần kế tiếp`;
        levelClass = 'error';
      }
    } else if (p.status === 'posted') {
      statusLabel = p.imageError ? '\u{2705} Đã đăng (không kèm được ảnh)' : '\u{2705} Đã đăng thành công';
      levelClass = 'success';
    } else if (p.status === 'failed') {
      statusLabel = `\u{274C} Đăng lỗi: ${escapeHtml(p.error || 'không rõ lỗi')}`;
      levelClass = 'error';
    }
    const actionBtn = p.status === 'pending'
      ? `<button type="button" class="btn-clear-log" data-cancel-schedule="${p.id}">Huỷ</button>`
      : `<button type="button" class="btn-clear-log" data-cancel-schedule="${p.id}">Xoá</button>`;
    return `<div class="log-entry ${levelClass}" style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
      <div><strong>${timeCaption ? `${timeCaption}: ` : ''}${escapeHtml(timeStr)}</strong>${repeatBadge}<br>${preview}<br><span class="hint-text">${statusLabel}</span></div>
      ${actionBtn}
    </div>`;
  }).join('');

  listEl.querySelectorAll('[data-cancel-schedule]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-cancel-schedule');
      const isPending = btn.innerText.trim() === 'Huỷ';
      await new Promise((res) => chrome.runtime.sendMessage({ action: 'CANCEL_SCHEDULED_POST', id }, res));
      logEvent('create', isPending ? 'Đã huỷ 1 bài hẹn giờ đăng.' : 'Đã xoá 1 lịch sử bài hẹn giờ đăng.', 'info');
      refreshScheduledPostsList();
    });
  });
}

// Xoá 1 lượt tất cả bài ĐÃ XONG (đã đăng thành công hoặc đăng lỗi) khỏi danh sách - chỉ
// dọn lịch sử hiển thị, không đụng tới các bài đang "Chờ đăng".
async function clearFinishedSchedules() {
  const posts = await new Promise((res) => chrome.runtime.sendMessage({ action: 'GET_SCHEDULED_POSTS' }, (resp) => res(resp && resp.success ? resp.posts : [])));
  const finished = (posts || []).filter((p) => p.status !== 'pending');
  if (finished.length === 0) return;
  await Promise.all(finished.map((p) => new Promise((res) => chrome.runtime.sendMessage({ action: 'CANCEL_SCHEDULED_POST', id: p.id }, res))));
  logEvent('create', `Đã xoá lịch sử ${finished.length} bài đăng đã hẹn giờ.`, 'info');
  refreshScheduledPostsList();
}

// Khi bài hẹn giờ được đăng lúc side panel đang ĐÓNG, background.js sẽ ghi tạm log
// vào storage - mở panel lên thì đọc và "xả" log đó vào Nhật ký Tạo Content rồi xoá đi.
async function flushScheduledPostLog() {
  const { scheduledPostLog } = await chrome.storage.local.get('scheduledPostLog');
  if (!Array.isArray(scheduledPostLog) || scheduledPostLog.length === 0) return;
  scheduledPostLog.slice().reverse().forEach((e) => {
    addLogEntry('create', { time: e.time, message: e.message, level: e.level });
  });
  renderLog('create');
  await chrome.storage.local.set({ scheduledPostLog: [] });
}

function updateAiProviderGroups(val) {
  document.getElementById('openaiSettingsGroup').classList.toggle('hidden', val !== 'openai');
  document.getElementById('geminiSettingsGroup').classList.toggle('hidden', val !== 'gemini');
  document.getElementById('deepseekSettingsGroup').classList.toggle('hidden', val !== 'deepseek');
}

// Link "Lấy API key tại ..." đổi theo Provider đang chọn (giống hình mẫu).
const PROVIDER_API_KEY_LINKS = {
  openai: { url: 'https://platform.openai.com/api-keys', label: 'Lấy OpenAI API key tại OpenAI Dashboard' },
  gemini: { url: 'https://aistudio.google.com/app/apikey', label: 'Lấy Gemini API key tại Google AI Studio' },
  deepseek: { url: 'https://platform.deepseek.com/api_keys', label: 'Lấy DeepSeek API key tại DeepSeek Platform' },
};
function updateProviderApiKeyLink(val) {
  const link = document.getElementById('providerApiKeyLink');
  if (!link) return;
  const info = PROVIDER_API_KEY_LINKS[val] || PROVIDER_API_KEY_LINKS.openai;
  link.href = info.url;
  link.textContent = info.label;
}

function setupAiProviderToggle() {
  const select = document.getElementById('aiProviderSelect');
  if (!select) return;
  select.addEventListener('change', async () => {
    updateAiProviderGroups(select.value);
    updateProviderApiKeyLink(select.value);
    await chrome.storage.local.set({ chip_aiProvider: select.value });
    showSavedToast();
    logEvent('settings', `Đã đổi Provider sang ${select.options[select.selectedIndex].text}`, 'info');
  });
}

function setupChipGroups() {
  document.querySelectorAll('.chip-group').forEach((group) => {
    const chips = group.querySelectorAll('.chip');
    if (chips.length === 0) return;
    const groupName = chips[0].getAttribute('data-group');
    chips.forEach((chip) => {
      chip.addEventListener('click', async () => {
        chips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        if (groupName) {
          await chrome.storage.local.set({ [`chip_${groupName}`]: chip.getAttribute('data-val') });
          showSavedToast();
        }
      });
    });
  });
}

// ============== SELECT-COLLAPSE (nhóm chip nhấn để mở ra rồi chọn) ==============
// Chỉ đổi cách HIỂN THỊ (thu gọn còn 1 dòng, bấm mới xoè list ra chọn) để tiết kiệm
// diện tích - các chip bên trong vẫn là .chip[data-group][data-val] như cũ, nên toàn bộ
// logic lưu/đọc storage của setupChipGroups()/getActiveChipValue()/loadSavedState()
// không cần đổi gì, chỉ cần đồng bộ lại chữ hiển thị trên nút bấm + tự đóng khi đã chọn.
function initSelectCollapseGroups() {
  document.querySelectorAll('.select-collapse').forEach((wrap) => {
    const trigger = wrap.querySelector('.select-trigger');
    const textEl = wrap.querySelector('.select-trigger-text');
    const options = wrap.querySelector('.select-options');
    if (!trigger || !options) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !wrap.classList.contains('open');
      document.querySelectorAll('.select-collapse.open').forEach((other) => {
        if (other !== wrap) other.classList.remove('open');
      });
      wrap.classList.toggle('open', willOpen);
    });

    options.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (textEl) textEl.textContent = chip.textContent.trim();
        wrap.classList.remove('open');
      });
    });
  });

  // Bấm ra ngoài bất kỳ ô nào đang mở -> tự đóng lại.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.select-collapse')) return;
    document.querySelectorAll('.select-collapse.open').forEach((wrap) => wrap.classList.remove('open'));
  });
}

// Gọi sau khi loadSavedState() đã phục hồi đúng chip nào đang active từ storage,
// để chữ hiển thị trên nút bấm (khi đang đóng) khớp với lựa chọn đã lưu trước đó.
function syncSelectTriggerLabels() {
  document.querySelectorAll('.select-collapse').forEach((wrap) => {
    const textEl = wrap.querySelector('.select-trigger-text');
    const activeChip = wrap.querySelector('.select-options .chip.active');
    if (textEl && activeChip) textEl.textContent = activeChip.textContent.trim();
  });
}

function getActiveChipValue(groupDataName) {
  const activeChip = document.querySelector(`.chip[data-group="${groupDataName}"].active`);
  return activeChip ? activeChip.getAttribute('data-val') : null;
}

// opts.selectable: bật chế độ "bấm vào tên để chọn / bỏ chọn" (dùng cho Username dự án & KOL, giống cách
// chọn logo/nhân vật). Username bị bỏ chọn VẪN nằm trong danh sách nhưng KHÔNG được dùng để quét.
// Trạng thái bỏ chọn được lưu riêng ở `${storageKey}Off` nên dữ liệu cũ (chỉ có danh sách tag) vẫn đọc bình thường
// và mặc định mọi username đều đang được chọn.
function setupTagInput(inputId, listId, storageKey, opts = {}) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  const selectable = !!opts.selectable;
  // single: mỗi lần CHỈ được chọn 1 username (chọn cái mới thì cái đang chọn tự bỏ chọn). Danh sách vẫn lưu được nhiều tên để đổi qua lại.
  const single = selectable && !!opts.single;
  const offKey = storageKey ? `${storageKey}Off` : null;
  let tags = [];
  let off = new Set(); // username (viết thường) đang bị bỏ chọn

  const isOff = (t) => off.has(t.toLowerCase());

  // Chỉ giữ đúng 1 tên được chọn (các tên còn lại đều vào danh sách "off").
  function selectOnly(tag) {
    off = new Set(tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()).map((t) => t.toLowerCase()));
  }

  function render() {
    list.innerHTML = '';
    tags.forEach((tag, idx) => {
      const span = document.createElement('span');
      const tagOff = selectable && isOff(tag);
      span.className = 'tag-item' + (selectable ? ' selectable' : '') + (tagOff ? ' off' : '');
      span.innerHTML = `<span class="tag-name">@${escapeHtml(tag)}</span><button type="button" class="tag-rm" title="Xoá">×</button>`;
      span.title = selectable
        ? (tagOff ? `@${tag} - chưa chọn, bấm để chọn quét${single ? ' (chỉ chọn được 1)' : ''}` : `@${tag} - đang chọn, bấm để bỏ chọn`)
        : `@${tag}`;
      if (selectable) {
        span.addEventListener('click', () => {
          const k = tag.toLowerCase();
          if (single) {
            // Đang chọn -> bấm lại để bỏ chọn; chưa chọn -> chọn tên này, tất cả tên khác tự bỏ chọn.
            if (off.has(k)) selectOnly(tag); else off.add(k);
          } else if (off.has(k)) off.delete(k); else off.add(k);
          render();
          persist();
        });
      }
      span.querySelector('.tag-rm').addEventListener('click', (e) => {
        e.stopPropagation();
        off.delete(tag.toLowerCase());
        tags.splice(idx, 1);
        render();
        persist();
      });
      list.appendChild(span);
    });
  }

  async function persist() {
    // onChange chạy TRƯỚC phần lưu ổ đĩa (và chạy dù ô này có storageKey hay không) - dùng
    // cho UI cần cập nhật ngay khi số lượng tag đổi, VD dòng "Đã có N username." của Tương
    // Tác Username, không phụ thuộc việc ô đó có tự lưu chrome.storage hay không.
    if (opts.onChange) opts.onChange(tags.slice());
    if (!storageKey) return;
    const payload = { [storageKey]: tags.slice() };
    if (offKey) payload[offKey] = tags.filter(isOff);
    await chrome.storage.local.set(payload);
    showSavedToast();
  }

  function addTag(raw) {
    const val = raw.replace('@', '').trim();
    if (val && !tags.some((t) => t.toLowerCase() === val.toLowerCase())) {
      tags.push(val);
      if (single) selectOnly(val); // tên vừa nhập trở thành tên đang chọn
      render();
      persist();
    }
  }

  // Thêm NHIỀU tag cùng lúc (VD: lọc được vài trăm username từ 1 đoạn text dán vào) - chỉ
  // render() + persist() ĐÚNG 1 LẦN sau khi đã gộp hết, thay vì gọi addTag() cho từng cái
  // (mỗi lần addTag() đều vẽ lại toàn bộ danh sách + ghi chrome.storage 1 lần -> vài trăm
  // username sẽ vẽ lại + ghi ổ đĩa vài trăm lần, rất tốn và có thể làm đơ panel).
  function addTags(rawArr) {
    let addedCount = 0;
    (rawArr || []).forEach((raw) => {
      const val = String(raw || '').replace('@', '').trim();
      if (val && !tags.some((t) => t.toLowerCase() === val.toLowerCase())) {
        tags.push(val);
        addedCount++;
      }
    });
    if (addedCount > 0) { render(); persist(); }
    return addedCount;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(input.value);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value && tags.length > 0) {
      const removed = tags.pop();
      off.delete(removed.toLowerCase());
      render();
      persist();
    }
  });

  // Dán NHIỀU username cùng lúc (cách nhau bởi xuống dòng, dấu phẩy, chấm phẩy hoặc
  // khoảng trắng) - trước đây ô này chỉ có xử lý phím Enter, nên dán 1 khối nhiều
  // username vào sẽ nằm nguyên trong ô như 1 chuỗi text dài, bắt phải xoá đi gõ/dán
  // lại TỪNG cái một rồi Enter. SỬA: bắt sự kiện paste, tự tách thành từng username
  // riêng rồi thêm hàng loạt bằng addTags() (chỉ vẽ lại + lưu ổ đĩa đúng 1 lần).
  // Nếu nội dung dán vào KHÔNG có dấu phân cách nào (chỉ đúng 1 từ) thì để trình
  // duyệt dán bình thường vào ô như cũ - vẫn gõ tiếp/Enter được như trước.
  input.addEventListener('paste', (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!pasted || !/[\s,;]/.test(pasted.trim())) return;
    e.preventDefault();
    const parts = pasted.split(/[\s,;\r\n]+/).map((s) => s.trim()).filter(Boolean);
    addTags(parts);
    input.value = '';
  });

  return {
    getTags: () => tags.slice(),
    // Chỉ các username ĐANG ĐƯỢC CHỌN (dùng để quét). Ô không bật selectable thì trả về toàn bộ.
    getSelectedTags: () => (selectable ? tags.filter((t) => !isOff(t)) : tags.slice()),
    addTags,
    // Xoá SẠCH toàn bộ danh sách (VD: nút "Xoá Toàn Bộ Danh Sách" của Tương Tác Username).
    clear: () => { tags = []; off = new Set(); render(); persist(); },
    setTags: (arr, offArr) => {
      tags = (arr || []).slice();
      off = new Set((offArr || []).map((x) => String(x).toLowerCase()));
      if (single) {
        // Dữ liệu cũ có thể đang chọn nhiều tên cùng lúc -> chỉ giữ tên đầu tiên đang chọn.
        const selected = tags.filter((t) => !off.has(t.toLowerCase()));
        if (selected.length > 1) selectOnly(selected[0]);
      }
      render();
      if (opts.onChange) opts.onChange(tags.slice());
    },
    flush: () => {
      if (input.value.trim()) {
        addTag(input.value);
        input.value = '';
      }
    }
  };
}

// Hộp danh sách username của Tương Tác Username - giống khung "Danh Sách Chạy" của Chéo Link:
// 1 ô textarea, mỗi dòng 1 @username, sửa/xoá trực tiếp được và tự lưu. Trả về đúng cùng bộ hàm
// (getTags / setTags / addTags / clear / flush) như setupTagInput nên phần chạy + quét comment
// + nạp dữ liệu đã lưu không cần đổi. Dữ liệu vẫn lưu ở `storageKey` dạng mảng tên (không có @)
// nên danh sách cũ của người dùng đọc lên bình thường.
async function loadSavedState() {
  const keys = [
    'openaiKey', 'aiModel', 'geminiKey', 'geminiModel', 'deepseekKey', 'deepseekModel', 'charLimitMin', 'charLimitMax', 'imageExtraPrompt', 'projectTagsOff', 'kolTagsOff',
    'typingSpeedMin', 'typingSpeedMax', 'chip_aiProvider',
    'crossLinkWordMin', 'crossLinkWordMax', 'crossLinkCustomStyle', 'crossLinkLikeAfterReply',
    'homeInteractMax', 'homeInteractDelay', 'homeInteractWordMin', 'homeInteractWordMax', 'homeInteractCustomStyle', 'homeInteractLikeAfterReply',
    'homeInteractPauseAfter', 'homeInteractPauseDuration', 'homeSkipLang', 'homeInteractWindows',
    'projectTags', 'kolTags',
    'cryptoCfg',
    'chatgptAutoEnabled', 'chatgptPollMinutes', 'chatgptTaskName', 'chatgptPostGapMin',
    'missions',
  ];
  CHIP_GROUPS.forEach((g) => keys.push(`chip_${g}`));
  const data = await chrome.storage.local.get(keys);

  if (data.openaiKey) document.getElementById('openaiKeyInput').value = data.openaiKey;
  if (data.aiModel) document.getElementById('aiModelSelect').value = data.aiModel;
  if (data.geminiKey) document.getElementById('geminiKeyInput').value = data.geminiKey;
  if (data.geminiModel) document.getElementById('geminiModelSelect').value = data.geminiModel;
  if (data.deepseekKey) document.getElementById('deepseekKeyInput').value = data.deepseekKey;
  if (data.deepseekModel) document.getElementById('deepseekModelSelect').value = data.deepseekModel;
  const savedProvider = data.chip_aiProvider || 'openai';
  document.getElementById('aiProviderSelect').value = savedProvider;
  updateAiProviderGroups(savedProvider);
  updateProviderApiKeyLink(savedProvider);
  document.getElementById('typingSpeedMinInput').value = data.typingSpeedMin || 30;
  document.getElementById('typingSpeedMaxInput').value = data.typingSpeedMax || 80;
  document.getElementById('charLimitMin').value = data.charLimitMin || 200;
  document.getElementById('charLimitMax').value = data.charLimitMax || 280;
  document.getElementById('imageExtraPrompt').value = data.imageExtraPrompt || '';

  // Cài đặt Reply AI (nút Reply AI trên mọi bài ở X.com) - ngôn ngữ/giọng văn nằm trong
  // nhóm chip (CHIP_GROUPS), ở đây chỉ còn các field chữ + toggle Like sau khi reply.
  document.getElementById('crossLinkWordMin').value = data.crossLinkWordMin || '';
  document.getElementById('crossLinkWordMax').value = data.crossLinkWordMax || '';
  document.getElementById('crossLinkCustomStyle').value = data.crossLinkCustomStyle || '';
  document.getElementById('crossLinkLikeToggle').checked = !!data.crossLinkLikeAfterReply; // mặc định tắt

  document.getElementById('homeInteractMaxInput').value = data.homeInteractMax || 10;
  document.getElementById('homeInteractDelayInput').value = data.homeInteractDelay || 5;
  document.getElementById('homeInteractWordMin').value = data.homeInteractWordMin || '';
  document.getElementById('homeInteractWordMax').value = data.homeInteractWordMax || '';
  document.getElementById('homeInteractCustomStyle').value = data.homeInteractCustomStyle || '';
  document.getElementById('homeInteractLikeToggle').checked = !!data.homeInteractLikeAfterReply; // mặc định tắt
  document.getElementById('homeInteractPauseAfterInput').value = data.homeInteractPauseAfter || '';
  document.getElementById('homeInteractPauseDurationInput').value = data.homeInteractPauseDuration || '';
  document.getElementById('homeSkipLangInput').value = data.homeSkipLang || '';
  homeWindows = Array.isArray(data.homeInteractWindows) ? data.homeInteractWindows.filter((w) => w && w.from && w.to) : [];
  renderHomeWindows();
  updateHomeSkipLangHint();

  CHIP_GROUPS.forEach((g) => {
    const val = data[`chip_${g}`];
    if (!val) return;
    const chip = document.querySelector(`.chip[data-group="${g}"][data-val="${val}"]`);
    if (!chip) return;
    document.querySelectorAll(`.chip[data-group="${g}"]`).forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    if (g === 'contentSource') {
      document.getElementById('projectScanGroup').classList.toggle('hidden', val !== 'project');
      document.getElementById('manualTopicGroup').classList.toggle('hidden', val !== 'manual');
      const tagTargetGroup = document.getElementById('tagTargetGroup');
      if (tagTargetGroup) tagTargetGroup.classList.toggle('hidden', val !== 'project');
    }
    if (g === 'postMode') {
      const scheduleGroup = document.getElementById('scheduleTimeGroup');
      if (scheduleGroup) scheduleGroup.classList.toggle('hidden', val !== 'schedule');
      if (val === 'schedule') ensureScheduleDefault();
    }
  });

  cryptoFillForm(data.cryptoCfg);
  refreshCryptoNextRunText();
  loadCryptoDrafts();

  document.getElementById('chatgptAutoToggle').checked = !!data.chatgptAutoEnabled;
  document.getElementById('chatgptPollInput').value = data.chatgptPollMinutes || 30;
  document.getElementById('chatgptTaskNameInput').value = data.chatgptTaskName || '';
  document.getElementById('chatgptPostGapInput').value = data.chatgptPostGapMin || '';
  refreshChatgptNextRunText();

  missions = (Array.isArray(data.missions) ? data.missions : []).map((m) => ({ ...m, samples: missionSamplesOf(m), sampleText: '' }));
  renderMissions();

  if (Array.isArray(data.projectTags)) projectTagInput.setTags(data.projectTags, data.projectTagsOff);
  if (Array.isArray(data.kolTags)) kolTagInput.setTags(data.kolTags, data.kolTagsOff);
}

// ============== GỌI AI DÙNG CHUNG (OpenAI / Gemini / DeepSeek) ==============
async function callChatAI(systemPrompt, userMessage, signal, maxTokens = 600, imageBase64 = null) {
  const store = await chrome.storage.local.get(['chip_aiProvider', 'openaiKey', 'aiModel', 'geminiKey', 'geminiModel', 'deepseekKey', 'deepseekModel']);
  const provider = store.chip_aiProvider || 'openai';

  if (provider === 'gemini') {
    if (!store.geminiKey) throw new Error('Chưa nhập Gemini API Key trong Cài Đặt!');
    const model = store.geminiModel || 'gemini-3.8-flash';
    // Đính kèm ảnh để AI PHÂN TÍCH (khác ảnh Logo/Nhân vật dùng để AI TẠO ảnh mới):
    // Gemini nhận ảnh qua field inline_data (base64 KHÔNG kèm phần "data:image/...;base64,"
    // ở đầu - phải tách bỏ phần đó ra, chỉ giữ đúng chuỗi base64 thuần).
    const parts = [{ text: `${systemPrompt}\n\n${userMessage}` }];
    if (imageBase64) {
      const match = imageBase64.match(/^data:(.+?);base64,(.+)$/);
      if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${store.geminiKey}`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: 1.15 } })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini không trả về nội dung (có thể bị chặn bởi bộ lọc an toàn).');
    return text;
  }

  if (provider === 'deepseek') {
    // DeepSeek (deepseek-chat/deepseek-reasoner) hiện KHÔNG hỗ trợ nhận ảnh đầu vào
    // (không phải model vision) - báo lỗi rõ ràng ngay từ đầu thay vì gửi API rồi nhận
    // lỗi khó hiểu, hoặc tệ hơn là API âm thầm bỏ qua ảnh khiến người dùng tưởng đã
    // phân tích ảnh nhưng thực chất AI chưa từng thấy ảnh đó.
    if (imageBase64) throw new Error('DeepSeek chưa hỗ trợ phân tích ảnh - vui lòng đổi sang OpenAI hoặc Gemini trong Cài Đặt để dùng tính năng đính kèm ảnh.');
    if (!store.deepseekKey) throw new Error('Chưa nhập DeepSeek API Key trong Cài Đặt!');
    const model = store.deepseekModel || 'deepseek-chat';
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.deepseekKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], max_tokens: maxTokens, temperature: 1.15, frequency_penalty: 0.5, presence_penalty: 0.3 })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;
  }

  // Mặc định: OpenAI
  if (!store.openaiKey) throw new Error('Chưa nhập OpenAI API Key trong Cài Đặt!');
  const openaiModel = store.aiModel || 'gpt-5.6-terra';
  // Dòng model "reasoning" (GPT-5.x, GPT-6, o1/o3/o4...) KHÔNG còn nhận tham số
  // max_tokens nữa (API trả lỗi 400: "Unsupported parameter: 'max_tokens'... Use
  // 'max_completion_tokens' instead") vì cần tách riêng ngân sách token suy luận
  // (reasoning tokens, ẩn) khỏi token trả lời hiển thị. Các model cũ (gpt-4o,
  // gpt-3.5-turbo...) vẫn dùng max_tokens như trước - tự nhận diện theo tên model
  // để không phải đổi tay mỗi khi thêm model mới vào danh sách.
  const isReasoningModel = /^(o[134](-|$)|gpt-5|gpt-6)/i.test(openaiModel);
  const tokenParamKey = isReasoningModel ? 'max_completion_tokens' : 'max_tokens';
  // BUG "GPT 5.6 không tạo được bài đăng": với model reasoning, max_completion_tokens
  // là ngân sách CHUNG cho cả token suy luận ẩn (reasoning tokens) lẫn nội dung trả lời
  // hiển thị. Việc viết 1 bài đăng vẫn khiến model suy luận khá nhiều trước khi viết,
  // nên với maxTokens mặc định (600 - đủ cho model thường như gpt-4o) toàn bộ ngân
  // sách bị ngốn hết bởi reasoning, không còn token nào để in ra nội dung -> content
  // rỗng -> sanitizeGeneratedContent() ném lỗi "AI trả về nội dung rỗng." ngay cả khi
  // API không hề báo lỗi gì. SỬA: (1) tăng ngân sách cho model reasoning để chừa chỗ
  // cho phần suy luận, (2) ép reasoning_effort ở mức thấp vì viết bài đăng ngắn không
  // cần suy luận sâu (giảm token suy luận bị tiêu tốn), (3) nếu vẫn rỗng do bị cắt vì
  // hết token (finish_reason 'length'), báo lỗi rõ ràng thay vì lỗi rỗng chung chung.
  const effectiveMaxTokens = isReasoningModel ? Math.max(maxTokens * 4, 2000) : maxTokens;
  // Ảnh đính kèm để AI PHÂN TÍCH: OpenAI nhận qua content dạng mảng gồm text + image_url
  // (định dạng "vision") thay vì chuỗi text đơn thuần như bình thường. Model chat hiện tại
  // (gpt-4o, gpt-5.x...) đều hỗ trợ sẵn định dạng này, không cần đổi endpoint.
  const userContent = imageBase64
    ? [{ type: 'text', text: userMessage }, { type: 'image_url', image_url: { url: imageBase64 } }]
    : userMessage;
  const requestBody = { model: openaiModel, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }], [tokenParamKey]: effectiveMaxTokens };
  if (isReasoningModel) {
    requestBody.reasoning_effort = 'low';
  } else {
    // Model KHÔNG reasoning (gpt-4o, gpt-4o-mini, gpt-3.5-turbo...) nhận temperature bình
    // thường - model reasoning thì KHÔNG (cố định temperature=1, gửi giá trị khác bị lỗi
    // 400 "Unsupported value"), nên chỉ set trong nhánh này.
    // LÝ DO: mặc định temperature=1.0 + không phạt lặp từ khiến model luôn chọn từ/cấu
    // trúc có xác suất cao nhất - đúng thứ tạo ra văn phong "an toàn, đều đều" nghe rất AI,
    // nhất là với reply ngắn (không gian để đa dạng hoá vốn đã ít). Nhích nhẹ 3 tham số này
    // giúp câu chữ lệch khỏi lựa chọn mặc định và giảm lặp mẫu câu giữa các lần gọi liên tiếp.
    requestBody.temperature = 1.15;
    requestBody.frequency_penalty = 0.5;
    requestBody.presence_penalty = 0.3;
  }
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.openaiKey}` },
    body: JSON.stringify(requestBody)
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content && choice && choice.finish_reason === 'length') {
    throw new Error(`Model "${openaiModel}" bị cắt nội dung vì hết token (toàn bộ ngân sách bị token suy luận ẩn tiêu thụ). Hãy thử tăng giới hạn token hoặc đổi sang model khác.`);
  }
  return content;
}

// Chặn trường hợp AI bị lỗi "runaway repetition" (sinh ra hàng nghìn ký tự lặp lại,
// ví dụ toàn dấu "!" hoặc 1 chữ cái) - nếu gõ y nguyên sẽ trông như "spam liên tục
// không ngừng" vì tool gõ từng ký tự thật theo tốc độ đã cài đặt.
//
// LỖI CŨ: /(.)\1{14,}/ chỉ bắt được đúng 1 KÝ TỰ ĐƠN lặp liên tiếp (ví dụ "!!!!!!!!!!!!!!!").
// Trên thực tế dạng lỗi hay gặp hơn là AI lặp đi lặp lại 1 CỤM VÀI ÂM TIẾT (ví dụ
// "hxh háh hxh hch hxh háh hxh h,h..." lặp vòng liên tục) - đây KHÔNG phải 1 ký tự lặp
// nên regex cũ bỏ lọt hoàn toàn, khiến câu rác này vẫn được gõ thẳng vào khung reply.
// Kiểm tra thêm ở mức TỪ/ÂM TIẾT: tỉ lệ từ duy nhất quá thấp, hoặc có 1 cụm 2-4 từ lặp
// lại quá nhiều lần trong 1 đoạn ngắn, đều coi là lỗi sinh văn bản dạng lặp vòng.
function hasRunawayWordRepetition(t) {
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 16) return false; // câu ngắn không đủ để kết luận chắc chắn

  const unique = new Set(words.map((w) => w.toLowerCase()));
  if (unique.size / words.length < 0.3) return true;

  for (const n of [2, 3, 4]) {
    const counts = new Map();
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n).join(' ').toLowerCase();
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    for (const c of counts.values()) {
      if (c >= 6) return true; // 1 cụm 2-4 từ lặp lại từ 6 lần trở lên -> chắc chắn lỗi lặp vòng
    }
  }
  return false;
}

// Rào chắn cơ học cho các cụm ghép gạch nối đặc trưng văn phong AI (real-life,
// base-level, real-world...) - cùng lý do như autoFormatParagraphs ở trên: prompt
// yêu cầu tránh dùng, nhưng không đảm bảo AI tuân thủ 100%, nên vẫn cần 1 lớp xử lý
// cơ học cuối cùng thay bằng cụm tự nhiên hơn thay vì để nguyên trong bài đăng.
const AI_HYPHEN_PHRASE_MAP = [
  [/\breal-life\b/gi, 'real life'],
  [/\breal-world\b/gi, 'real world'],
  [/\bbase-level\b/gi, 'foundational'],
  [/\bnext-level\b/gi, 'next level'],
  [/\bcutting-edge\b/gi, 'advanced'],
  [/\bgame-changing\b/gi, 'significant'],
  [/\btop-tier\b/gi, 'high-quality'],
  [/\bbest-in-class\b/gi, 'top'],
];
function stripAiHyphenPhrases(text) {
  let t = text;
  for (const [regex, replacement] of AI_HYPHEN_PHRASE_MAP) {
    t = t.replace(regex, replacement);
  }
  return t;
}

// Rào chắn cuối cùng cho bố cục: dù prompt đã yêu cầu xuống dòng giữa các đoạn, mô hình
// AI đôi khi vẫn ưu tiên bám đúng giới hạn ký tự hơn và trả về nguyên 1 khối văn bản liền
// mạch không có dòng trống nào. Nếu phát hiện đúng trường hợp đó (chưa có đoạn nào tách
// dòng trống, và đủ nhiều câu để tách), tự động chia lại thành các đoạn 1-2 câu thay vì
// đăng nguyên 1 khối - không đụng vào nếu văn bản đã có sẵn đoạn cách dòng trống rồi
// (tôn trọng bố cục AI tự chia, tránh xé lẻ những đoạn đã hợp lý).
function autoFormatParagraphs(text) {
  if (/\n\s*\n/.test(text)) return text;
  const sentences = text.match(/[^.!?…]+[.!?…]+(\s+|$)|[^.!?…]+$/g);
  if (!sentences || sentences.length < 3) return text; // quá ít câu thì không cần tách
  const paragraphs = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const p = sentences.slice(i, i + 2).join('').trim();
    if (p) paragraphs.push(p);
  }
  return paragraphs.length > 1 ? paragraphs.join('\n\n') : text;
}

// ============== BỎ DẤU "." VÀ "," Ở CUỐI CÂU/CUỐI ĐOẠN CỦA BÀI ĐĂNG ==============
// Yêu cầu: bài đăng KHÔNG để dấu chấm hoặc dấu phẩy ở cuối câu (kể cả câu đầu tiên của bài).
// Prompt chỉ là hướng dẫn nên model vẫn hay để sót -> lọc lại bằng code:
//  (1) Tách các câu dính chung 1 đoạn thành từng đoạn riêng (mỗi câu 1 đoạn, cách nhau 1 dòng
//      trống) - chỉ tách ở ". " + chữ HOA, bỏ qua các từ viết tắt phổ biến (Dr., Mr., vs., ...).
//  (2) Cắt "." / "," / "。" / "，" ở cuối MỖI dòng. Dấu "..." / "…", "!" và "?" được giữ nguyên.
function splitSentencesToParagraphs(text) {
  return String(text || '').replace(
    /(?<=[\p{Ll}0-9)\]"'])(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|vs|etc|Inc|Ltd|Jr|Sr|St|No))\.[ \t]+(?=[\p{Lu}@"])/gu,
    '\n\n'
  );
}

function stripTrailingSentencePunctuation(text) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      const t = line.replace(/\s+$/, '');
      if (/(\.{2,}|…)$/.test(t)) return t; // dấu lửng: giữ nguyên
      return t.replace(/[.,，。]+$/, '').replace(/\s+$/, '');
    })
    .join('\n');
}

function formatPostSentences(text) {
  return stripTrailingSentencePunctuation(splitSentencesToParagraphs(text));
}

// Xử lý cho nội dung DÀI (Tạo Content) - không cắt ngắn như reply, chỉ chặn lỗi lặp
// ký tự bất thường và sửa cơ học vài dấu hiệu "AI viết" (em dash, ngoặc kép cong).
function sanitizeGeneratedContent(text) {
  let t = (text || '').trim();
  if (!t) throw new Error('AI trả về nội dung rỗng.');
  if (/(.)\1{14,}/.test(t)) {
    throw new Error('AI trả về nội dung lặp ký tự bất thường (lỗi sinh văn bản) - đã huỷ.');
  }
  if (hasRunawayWordRepetition(t)) {
    throw new Error('AI trả về nội dung lặp cụm từ/âm tiết bất thường theo vòng (lỗi sinh văn bản) - đã huỷ.');
  }
  t = t.replace(/\s*—\s*/g, ', ').replace(/[""]/g, '"').replace(/['']/g, "'");
  t = stripAiHyphenPhrases(t);
  t = autoFormatParagraphs(t);
  t = formatPostSentences(t);
  return cleanPostPunctuation(t);
}

// Đảm bảo bài viết LUÔN tag đúng đối tượng người dùng đã chọn (Tag dự án / Tag KOLs /
// Cả 2) - phòng trường hợp AI bỏ sót yêu cầu tag dù đã có chỉ dẫn trong prompt.
// Nếu thiếu tag, KHÔNG dán trơ "@user" vào cuối vì sẽ mất ngữ cảnh - thay vào đó chèn
// thành 1 câu ngắn có ngữ cảnh (nhắc nguồn tin) để việc tag vẫn tự nhiên, đúng chỗ.
function ensureTargetTags(text, usernames, lang = 'vi') {
  const missing = (usernames || []).filter((u) => u && !new RegExp(`@${u}\\b`, 'i').test(text));
  if (missing.length === 0) return text;
  const mentionList = missing.map((u) => `@${u}`).join(' ');
  const contextSentence = lang === 'en'
    ? `This update comes from ${mentionList}.`
    : lang === 'zh'
    ? `此消息来自 ${mentionList}。`
    : `Thông tin này được cập nhật từ ${mentionList}.`;
  return stripTrailingSentencePunctuation(`${text}\n\n${contextSentence}`);
}

function sanitizeReplyText(text, maxLen = 300) {
  let t = (text || '').trim();
  if (!t) throw new Error('AI trả về nội dung rỗng.');

  // Cùng 1 ký tự lặp lại liên tiếp từ 15 lần trở lên -> chắc chắn là lỗi sinh văn bản.
  if (/(.)\1{14,}/.test(t)) {
    throw new Error('AI trả về nội dung lặp ký tự bất thường (lỗi sinh văn bản) - đã huỷ để tránh spam.');
  }

  // Lỗi "lặp vòng 1 cụm âm tiết/từ" (ví dụ "hxh háh hxh hch hxh háh..." lặp liên tục) -
  // không phải 1 ký tự lặp nên regex ở trên bỏ lọt, phải kiểm tra riêng ở mức từ.
  if (hasRunawayWordRepetition(t)) {
    throw new Error('AI trả về nội dung lặp cụm từ/âm tiết bất thường theo vòng (lỗi sinh văn bản) - đã huỷ để tránh spam.');
  }

  // Xử lý cơ học cho vài dấu hiệu "AI viết" mà prompt có thể lỡ không tuân theo hết:
  // em dash "—", ngoặc kép cong, và các cụm ghép gạch nối kiểu AI (real-life...).
  t = t.replace(/\s*—\s*/g, ', ').replace(/[""]/g, '"').replace(/['']/g, "'");
  t = stripAiHyphenPhrases(t);
  t = stripReplyAiTells(t);

  if (t.length > maxLen) t = t.slice(0, maxLen).trim();
  return t;
}

// Dọn cơ học các tật mà model VẪN hay mắc dù prompt đã cấm rõ. Prompt là hướng dẫn, không
// phải ràng buộc cứng - đặc biệt các mẫu mở đầu kiểu "Absolutely," hay việc bọc cả reply
// trong ngoặc kép là thói quen rất khó bỏ của model. Lọc lại ở đây cho chắc.
const REPLY_FILLER_OPENERS = [
  'absolutely', 'indeed', 'exactly', 'totally agree', 'i agree', 'agreed', 'well said',
  'great point', 'great post', 'great thread', 'love this', 'this', 'so true', 'facts',
  'chuẩn luôn', 'chuẩn rồi', 'chuẩn', 'quá đúng', 'đúng vậy', 'đồng ý', 'hoàn toàn đồng ý',
  'quá chuẩn', 'nói quá đúng', 'bài hay', 'góc nhìn hay', 'cảm ơn bạn đã chia sẻ'
];

function stripReplyAiTells(text) {
  let t = (text || '').trim();

  // Nhãn thừa model hay tự thêm vào đầu ("Reply:", "Trả lời:", "Câu trả lời:").
  t = t.replace(/^\s*(reply|response|answer|trả lời|câu trả lời|phản hồi)\s*[:：-]\s*/i, '').trim();

  // Bọc toàn bộ reply trong 1 cặp ngoặc kép -> bỏ cặp ngoặc đó đi (chỉ khi bọc trọn vẹn,
  // để không phá các reply có trích dẫn thật ở giữa câu).
  while (t.length > 1 && /^["'`]/.test(t) && t.slice(-1) === t[0] && !t.slice(1, -1).includes(t[0])) {
    t = t.slice(1, -1).trim();
  }

  // Emoji + hashtag: prompt reply đã cấm, nhưng model vẫn hay nhét emoji cuối câu.
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '');
  t = t.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1');

  // Cụm tán thành rỗng ở ĐẦU reply -> cắt bỏ, giữ lại phần nội dung thật phía sau. Chỉ cắt
  // khi phía sau còn nội dung đủ dài, nếu không sẽ xoá sạch cả reply.
  for (const opener of REPLY_FILLER_OPENERS) {
    const re = new RegExp(`^${opener.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,.!:;-]+\\s*`, 'i');
    if (re.test(t)) {
      const rest = t.replace(re, '').trim();
      if (rest.length >= 8) t = rest;
      break;
    }
  }

  return t.replace(/\s{2,}/g, ' ').trim();
}

function stopGeneration() {
  if (currentAbortController) currentAbortController.abort();
  chrome.runtime.sendMessage({ action: 'STOP_FLOW' }).catch(() => {});
}

// ============== TẠO CONTENT (nút CHẠY) ==============
async function generateContentAI() {
  const store = await chrome.storage.local.get(['chip_aiProvider', 'openaiKey', 'geminiKey', 'deepseekKey']);
  const provider = store.chip_aiProvider || 'openai';
  const hasKey = provider === 'gemini' ? store.geminiKey : provider === 'deepseek' ? store.deepseekKey : store.openaiKey;
  if (!hasKey) return alert(`Vui lòng nhập API Key cho ${provider.toUpperCase()} trong Cài Đặt!`);

  currentAbortController = new AbortController();
  document.getElementById('btnGenerateContent').classList.add('hidden');
  document.getElementById('btnGenerateContentSchedule')?.classList.add('hidden');
  document.getElementById('btnStopGenerate').classList.remove('hidden');
  const statusText = document.getElementById('generateStatusText');
  statusText.innerText = 'Đang khởi chạy...';
  logEvent('create', 'Bắt đầu Tạo Content...', 'info');

  try {
    const contentSource = getActiveChipValue('contentSource');
    const postType = getActiveChipValue('postType');
    const needMedia = getActiveChipValue('needMedia');
    const imageSource = getActiveChipValue('imageSource');
    const imageExtraPrompt = (document.getElementById('imageExtraPrompt').value || '').trim();
    const tone = getActiveChipValue('tone');
    const contentLang = getActiveChipValue('contentLang') || 'vi';
    const langInstruction = contentLang === 'en'
      ? 'BẮT BUỘC viết bằng tiếng Anh (English).'
      : contentLang === 'zh'
      ? 'BẮT BUỘC viết bằng tiếng Trung giản thể (中文), văn phong tự nhiên như người Trung Quốc thật viết.'
      : 'BẮT BUỘC viết bằng tiếng Việt.';
    // Đọc trực tiếp từ ô input đang hiển thị - KHÔNG dùng số mặc định (200/280) nữa,
    // vì cài đặt độ dài đã luôn có sẵn giá trị thật (loadSavedState() điền sẵn khi mở
    // panel). Nếu ô trống/không hợp lệ, báo lỗi rõ ràng thay vì âm thầm rơi về mặc định
    // khiến người dùng tưởng đã áp dụng đúng cài đặt của họ nhưng thực ra không phải.
    const minLen = parseInt(document.getElementById('charLimitMin').value, 10);
    const maxLen = parseInt(document.getElementById('charLimitMax').value, 10);
    if (!minLen || !maxLen || minLen <= 0 || maxLen <= 0) {
      throw new Error('Vui lòng nhập Độ dài bài đăng (Tối thiểu/Tối đa) hợp lệ trong Setting Tạo Content!');
    }
    if (minLen > maxLen) {
      throw new Error('Độ dài Tối thiểu đang lớn hơn Tối đa, vui lòng kiểm tra lại Setting Tạo Content!');
    }
    // Cảnh báo sớm trước khi tốn lượt gọi AI: extension hiện CHƯA có logic đăng thread
    // thật sự (tách nhiều tweet nối tiếp) - dù chọn "Thread", nội dung vẫn bị gõ dồn vào
    // 1 khung tweet duy nhất khi đăng. Nếu Độ dài tối đa vượt giới hạn 280 ký tự/tweet
    // (giới hạn của tài khoản X thường, không có Premium), nút Đăng trên X sẽ bị khoá
    // cứng lúc đăng bài dù nội dung đã tạo xong bình thường.
    if (postType !== 'thread' && maxLen > 280) {
      logEvent('create', `Lưu ý: Độ dài tối đa đang đặt ${maxLen} ký tự, vượt giới hạn 280 ký tự/tweet thường của X - nút Đăng có thể bị khoá lúc đăng nếu tài khoản không có X Premium.`, 'error');
    } else if (postType === 'thread' && maxLen > 280) {
      logEvent('create', `Lưu ý: đã chọn Thread nhưng extension hiện chỉ đăng vào 1 tweet duy nhất (chưa hỗ trợ tách nhiều tweet nối tiếp) - nội dung ${maxLen} ký tự có thể khiến nút Đăng bị khoá nếu tài khoản không có X Premium.`, 'error');
    }
    const formatLabel = postType === 'thread' ? 'Thread 4-5 tweet' : '1 Tweet duy nhất';

    const postMode = getActiveChipValue('postMode') || 'now';

    // ĐÚNG YÊU CẦU: nếu là "Hẹn giờ đăng", KHÔNG quét dữ liệu/gọi AI/tạo ảnh ngay bây giờ
    // nữa - chỉ chốt lại "công thức" (recipe) rồi gửi cho background.js lưu lịch. Toàn bộ
    // thao tác quét + viết bài + tạo ảnh chỉ thực sự chạy đúng lúc tới giờ hẹn (xem
    // generateContentFromRecipe() + chrome.alarms.onAlarm trong background.js).
    if (postMode === 'schedule') {
      const scheduledDate = getScheduledDateFromSelects();
      if (!scheduledDate || isNaN(scheduledDate.getTime())) throw new Error('Vui lòng chọn đầy đủ ngày giờ muốn hẹn đăng!');
      if (scheduledDate.getTime() <= Date.now() + 5000) {
        throw new Error('Thời gian hẹn phải ở tương lai so với giờ hiện tại trên máy!');
      }

      const recipe = { contentSource, postType, needMedia, imageSource, imageExtraPrompt, tone, contentLang, minLen, maxLen };
      if (contentSource === 'project') {
        projectTagInput.flush();
        kolTagInput.flush();
        const projectUsers = projectTagInput.getSelectedTags();
        const kolUsers = kolTagInput.getSelectedTags();
        if (projectUsers.length === 0) throw new Error(projectTagInput.getTags().length > 0 ? 'Bạn chưa chọn Username dự án nào để quét! Bấm vào tên dự án để chọn.' : 'Vui lòng nhập Username Dự án!');
        const tagTarget = getActiveChipValue('tagTarget') || 'project';
        if (tagTarget === 'kols' && kolUsers.length === 0) throw new Error('Bạn chọn "Tag KOLs" nhưng chưa nhập/chọn Username KOL!');
        if (tagTarget === 'both' && kolUsers.length === 0) throw new Error('Bạn chọn "Cả 2" nhưng chưa nhập/chọn Username KOL!');
        recipe.projectUsers = projectUsers;
        recipe.kolUsers = kolUsers;
        recipe.tagTarget = tagTarget;
      } else {
        const topic = document.getElementById('topicInput').value.trim();
        if (!topic && !manualAnalysisImageBase64) throw new Error('Nhập chủ đề hoặc đính kèm ảnh để AI phân tích!');
        recipe.topic = topic;
        // Ảnh để AI PHÂN TÍCH lúc viết bài - lưu thẳng base64 vào recipe (không cần cơ
        // chế "chụp nhanh từ gallery" như logoBase64/charBase64, vì ảnh này vốn chỉ dùng
        // 1 lần cho đúng bài hẹn giờ này, không phải thư viện tái sử dụng).
        if (manualAnalysisImageBase64) recipe.topicImageBase64 = manualAnalysisImageBase64;
      }

      const repeatDaily = document.getElementById('scheduleRepeatDailyToggle')?.checked || false;

      statusText.innerText = '\u{1F4BE} Đang lưu lịch đăng...';
      document.getElementById('resultCard').classList.add('hidden');
      const schedId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await new Promise((res, rej) => chrome.runtime.sendMessage({
        action: 'SCHEDULE_POST',
        id: schedId,
        recipe,
        scheduledTime: scheduledDate.getTime(),
        repeatDaily,
      }, (r) => (r && r.success ? res(r) : rej(new Error(r?.error || 'Lỗi lên lịch đăng bài.')))));

      statusText.innerText = '\u{2705} Đã hẹn giờ!';
      const timeLabel = scheduledDate.toLocaleString('vi-VN');
      logEvent('create',
        repeatDaily
          ? `Đã hẹn giờ đăng bài lúc ${timeLabel}, LẶP LẠI HÀNG NGÀY (mỗi lần sẽ tạo nội dung mới, có tránh trùng với các bài trước).`
          : `Đã hẹn giờ đăng bài lúc ${timeLabel} (sẽ tạo nội dung đúng lúc tới giờ, chưa tạo trước).`,
        'success'
      );
      showSavedToast(repeatDaily ? `Đã lên lịch lặp lại hàng ngày lúc ${timeLabel}` : `Đã lên lịch đăng lúc ${timeLabel}`);
      await refreshScheduledPostsList();
      return;
    }

    // postMode === 'now': giữ nguyên luồng cũ - quét dữ liệu (nếu cần) -> gọi AI viết bài
    // -> tạo ảnh (nếu cần) -> tự động bấm Đăng ngay lập tức.
    let systemPrompt = '', userMessage = '';
    let scrapeTabId = null;
    let projectUser = '', kolUser = '';
    let tagUsernames = [];
    if (contentSource === 'project') {
      projectTagInput.flush();
      kolTagInput.flush();
      const projectUsers = projectTagInput.getSelectedTags();
      const kolUsers = kolTagInput.getSelectedTags();
      if (projectUsers.length === 0) throw new Error(projectTagInput.getTags().length > 0 ? 'Bạn chưa chọn Username dự án nào để quét! Bấm vào tên dự án để chọn.' : 'Vui lòng nhập Username Dự án!');

      projectUser = projectUsers[Math.floor(Math.random() * projectUsers.length)];

      // Đối tượng cần tag trong bài viết theo lựa chọn ở khung "Tag trong bài viết":
      // chỉ tag dự án / chỉ tag KOL / tag cả 2 - độc lập với việc quét dữ liệu qua ai.
      const tagTarget = getActiveChipValue('tagTarget') || 'project';
      if (tagTarget === 'kols' && kolUsers.length === 0) throw new Error('Bạn chọn "Tag KOLs" nhưng chưa nhập/chọn Username KOL!');
      if (tagTarget === 'both' && kolUsers.length === 0) throw new Error('Bạn chọn "Cả 2" nhưng chưa nhập/chọn Username KOL!');

      statusText.innerText = '\u{23F3} Đang quét dữ liệu X...';
      // Giữ lại tab vừa quét (không đóng) để tí nữa chuyển hướng luôn sang trang đăng bài,
      // đỡ phải mở thêm 1 tab mới hoàn toàn cho bước đăng.
      let refTweet;
      if (kolUsers.length > 0) {
        // Chọn NHIỀU KOL: background thử lần lượt theo thứ tự danh sách, KOL nào không có bài
        // tag dự án thì tự chuyển sang KOL kế tiếp (tiến độ báo về qua KOL_FALLBACK_PROGRESS).
        // KOL thực sự dùng được được trả về trong r.kolUsername -> dùng đúng KOL đó để tag.
        const r = await new Promise((res, rej) => chrome.runtime.sendMessage({ action: 'SCRAPE_KOL_CLONE', kolUsernames: kolUsers, projectUsername: projectUser }, r => r && r.success ? res(r) : rej(new Error(r?.error || 'Lỗi quét KOL'))));
        refTweet = r.tweet;
        scrapeTabId = r.tabId;
        kolUser = r.kolUsername || kolUsers[0];
      } else {
        const r = await new Promise((res, rej) => chrome.runtime.sendMessage({ action: 'SCRAPE_PROJECT_TWEETS', projectUsername: projectUser }, r => r && r.success ? res(r) : rej(new Error(r?.error))));
        refTweet = r.tweets[0];
        scrapeTabId = r.tabId;
      }

      if (tagTarget === 'kols') tagUsernames = [kolUser];
      else if (tagTarget === 'both') tagUsernames = [projectUser, kolUser];
      else tagUsernames = [projectUser];

      logEvent('create', `Đã quét dữ liệu từ @${projectUser}${kolUser ? ` (qua @${kolUser})` : ''}`, 'success');

      const perspectiveInstruction = kolUser ? '' : buildProjectPerspectiveInstruction(projectUser);
      const tagList = tagUsernames.map((u) => `@${u}`).join(' và ');
      const tagInstruction = `BẮT BUỘC phải nhắc đến (tag) ${tagList} ĐÚNG NGỮ CẢNH - chỉ đặt tag ngay tại câu đang nói về đối tượng đó (dự án/KOL), chèn tự nhiên như một phần của câu văn (không phải dán trơ tag vào cuối bài, không tag ở chỗ không liên quan). TUYỆT ĐỐI KHÔNG tag/nhắc bất kỳ tài khoản nào khác ngoài ${tagList}.`;

      systemPrompt = `Bạn là chuyên gia Crypto/Web3. Phân tích bài gốc và viết 1 bài đăng ${formatLabel} MỚI.
1. ${NATURAL_PARAGRAPH_INSTRUCTION}
2. GIỮ NGUYÊN 100% dữ liệu thực tế.
3. Giọng văn: ${getToneDescription(tone)}
4. Độ dài mỗi tweet: ${minLen}-${maxLen} ký tự.
5. Ngôn ngữ: ${langInstruction}
6. ${tagInstruction}${perspectiveInstruction ? `
7. ${perspectiveInstruction}` : ''}

${ANTI_AI_STYLE_GUIDE}

NHẮC LẠI QUAN TRỌNG: bài viết PHẢI được chia thành nhiều đoạn ngắn cách nhau bằng 1 dòng trống. TUYỆT ĐỐI không được viết thành 1 khối văn bản liền mạch duy nhất, kể cả khi làm vậy sẽ dễ bám sát giới hạn ký tự hơn.`;
      userMessage = kolUser
        ? `Bài tham khảo:\n"${refTweet.text}"`
        : `Bài tham khảo (do chính tài khoản dự án @${projectUser} đăng, KHÔNG phải góc nhìn của bạn - bạn là người sáng tạo nội dung độc lập, viết lại ở ngôi thứ ba khi nói về dự án):\n"${refTweet.text}"`;
    } else {
      const topic = document.getElementById('topicInput').value.trim();
      if (!topic && !manualAnalysisImageBase64) throw new Error('Nhập chủ đề hoặc đính kèm ảnh để AI phân tích!');

      if (manualAnalysisImageBase64) {
        // Chế độ PHÂN TÍCH ẢNH: AI phải tự xem nội dung/chữ/logo trong ảnh để quyết định
        // nên viết gì - topic (nếu có) chỉ là ĐỊNH HƯỚNG THÊM, không bắt buộc.
        systemPrompt = `${NATURAL_PARAGRAPH_INSTRUCTION}\n\nBạn được cung cấp kèm theo 1 hình ảnh. Hãy XEM KỸ toàn bộ nội dung, chữ, logo, nhân vật, số liệu... xuất hiện trong ảnh để hiểu nó đang nói về điều gì, rồi viết 1 bài đăng ${formatLabel} dựa theo đúng nội dung/thông điệp của ảnh đó.${topic ? ` Có tham khảo thêm định hướng của người dùng: "${topic}".` : ''}
NẾU trong ảnh có logo/thương hiệu/dự án mà bạn NHẬN RA rõ ràng và CHẮC CHẮN biết đúng username X (Twitter) chính thức của họ, hãy tag (@) đúng username đó tại đúng câu đang nói về họ, chèn tự nhiên như 1 phần của câu văn. TUYỆT ĐỐI KHÔNG bịa/đoán mò username nếu không chắc chắn 100% - thà không tag còn hơn tag sai hoặc tag 1 tài khoản không liên quan.
Giọng văn: ${getToneDescription(tone)}. Ký tự: ${minLen}-${maxLen}. Ngôn ngữ: ${langInstruction}

${ANTI_AI_STYLE_GUIDE}

NHẮC LẠI QUAN TRỌNG: bài viết PHẢI được chia thành nhiều đoạn ngắn cách nhau bằng 1 dòng trống. TUYỆT ĐỐI không được viết thành 1 khối văn bản liền mạch duy nhất, kể cả khi làm vậy sẽ dễ bám sát giới hạn ký tự hơn.`;
        userMessage = 'Phân tích hình ảnh đính kèm và viết bài đăng theo đúng yêu cầu ở trên.';
      } else {
        systemPrompt = `${NATURAL_PARAGRAPH_INSTRUCTION}\n\nViết bài đăng ${formatLabel}. Giọng văn: ${getToneDescription(tone)}. Ký tự: ${minLen}-${maxLen}. Ngôn ngữ: ${langInstruction}\n\n${ANTI_AI_STYLE_GUIDE}\n\nNHẮC LẠI QUAN TRỌNG: bài viết PHẢI được chia thành nhiều đoạn ngắn cách nhau bằng 1 dòng trống. TUYỆT ĐỐI không được viết thành 1 khối văn bản liền mạch duy nhất, kể cả khi làm vậy sẽ dễ bám sát giới hạn ký tự hơn.`;
        userMessage = topic;
      }
    }

    statusText.innerText = '\u{23F3} Đang tạo bài viết...';
    if (manualAnalysisImageBase64) logEvent('create', 'Đang gửi ảnh cho AI phân tích...', 'info');
    let generatedText = sanitizeGeneratedContent(await callChatAI(systemPrompt, userMessage, currentAbortController.signal, 600, manualAnalysisImageBase64));
    if (contentSource === 'project') {
      generatedText = ensureTargetTags(generatedText, tagUsernames, contentLang);
    }
    logEvent('create', 'Đã tạo nội dung bài viết bằng AI', 'success');

    document.getElementById('resultCard').classList.remove('hidden');
    document.getElementById('generatedTextContent').innerText = generatedText;

    let imgUrl = null;
    if (needMedia === 'image') {
      statusText.innerText = '\u{1F3A8} Đang tạo ảnh...';
      // Lấy TOÀN BỘ ảnh đang chọn ở mục Logo & Nhân vật (chọn được nhiều ảnh - nhân vật
      // phụ...). logoBase64/charBase64 (ảnh đầu tiên) vẫn được gửi kèm để tương thích
      // ngược với bản content_chatgpt.js/content_gemini.js cũ chỉ hiểu 1 ảnh mỗi bên.
      const logoBase64List = []; // đã bỏ mục Logo - chỉ dùng ảnh Nhân vật
      const charBase64List = await getActiveGalleryImages('charLibrary');
      imgUrl = await new Promise((res, rej) => chrome.runtime.sendMessage({ action: 'GENERATE_IMAGE_FLOW', source: imageSource, promptText: generatedText, logoBase64List, charBase64List, logoBase64: logoBase64List[0] || null, charBase64: charBase64List[0] || null, extraPrompt: imageExtraPrompt, reuseTabId: scrapeTabId }, r => r && r.success ? res(r.imgUrl) : rej(new Error(r?.error))));
      document.getElementById('mediaPreviewContainer').classList.remove('hidden');
      document.getElementById('generatedImagePreview').src = imgUrl;
      logEvent('create', `Đã tạo ảnh minh hoạ (nguồn: ${imageSource})`, 'success');
    }

    document.getElementById('resultCardTitle').innerText = 'Nội dung bài viết (Đã tự động bấm đăng bài)';
    statusText.innerText = '\u{1F680} Đang tự động bấm Đăng bài...';
    const postRes = await new Promise((res, rej) => chrome.runtime.sendMessage({ action: 'POST_TO_X', contentText: generatedText, imageUrl: imgUrl, reuseTabId: scrapeTabId, closeAfter: true }, r => r && r.success ? res(r) : rej(new Error(r?.error))));
    const imageError = postRes?.result?.imageError;
    statusText.innerText = '\u{2705} Hoàn tất!';
    if (imageError) {
      logEvent('create', `Đăng bài thành công nhưng KHÔNG đính kèm được ảnh: ${imageError}`, 'error');
      showSavedToast('Đăng bài thành công nhưng KHÔNG đính kèm được ảnh - xem chi tiết trong Nhật ký hoạt động');
    } else {
      logEvent('create', 'Đăng bài thành công!', 'success');
      showSavedToast('Đăng bài thành công!');
    }
  } catch (err) {
    statusText.innerText = '\u{274C} Lỗi';
    logEvent('create', `Lỗi Tạo Content: ${err.message}`, 'error');
    alert(`Lỗi: ${err.message}`);
  } finally {
    document.getElementById('btnGenerateContent').classList.remove('hidden');
    document.getElementById('btnGenerateContentSchedule')?.classList.remove('hidden');
    document.getElementById('btnStopGenerate').classList.add('hidden');
    setTimeout(() => { if (statusText.innerText !== STATUS_IDLE) statusText.innerText = STATUS_IDLE; }, 2500);
  }
}

function getToneDescription(tone) {
  const toneMap = {
    informative: 'Phân tích chuyên sâu, điềm tĩnh.',
    bullish: 'Hype tích cực, nhiều năng lượng.',
    degen: 'Hài hước, meme, nhiều slang.',
    neutral: 'Trung lập, khách quan.',
    kol_insight: 'Góc nhìn KOL có kinh nghiệm.'
  };
  return toneMap[tone] || toneMap.informative;
}

// ============== NGÔN NGỮ REPLY "THEO NGÔN NGỮ BÀI ĐĂNG" ==============
// LỖI CŨ: chế độ "Theo Ngôn Ngữ bài đăng" chỉ gắn 1 câu mơ hồ ("Trả lời bằng ngôn ngữ của bài
// đăng.") vào prompt mà TOÀN BỘ phần còn lại của prompt (giọng văn, quy tắc chống văn AI...) đều
// viết bằng Tiếng Việt, nên AI mặc định bám theo ngôn ngữ của prompt và reply Tiếng Việt cho cả
// bài tiếng Anh. SỬA: tự xác định ngôn ngữ thật của bài (ưu tiên thuộc tính lang X gắn sẵn,
// không có thì đoán theo chữ viết/từ vựng) rồi ghi RÕ TÊN ngôn ngữ cần dùng vào prompt, kèm câu
// nhấn mạnh việc prompt viết bằng Tiếng Việt không liên quan tới ngôn ngữ của reply.
const REPLY_LANG_NAMES = {
  en: 'English', vi: 'Vietnamese (Tiếng Việt)', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', th: 'Thai',
  ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic', fa: 'Persian', hi: 'Hindi', he: 'Hebrew', bn: 'Bengali',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', id: 'Indonesian', tr: 'Turkish', it: 'Italian',
  nl: 'Dutch', pl: 'Polish', tl: 'Filipino', fil: 'Filipino', ms: 'Malay', ro: 'Romanian', cs: 'Czech',
  sv: 'Swedish', el: 'Greek', ur: 'Urdu', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', fi: 'Finnish',
  da: 'Danish', no: 'Norwegian', hu: 'Hungarian',
};

const LANG_STOPWORDS = {
  en: ['the', 'and', 'is', 'are', 'to', 'of', 'in', 'for', 'with', 'this', 'that', 'it', 'you', 'on', 'be', 'we', 'have', 'just', 'not', 'what'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'del', 'se', 'muy', 'pero'],
  fr: ['le', 'la', 'les', 'des', 'et', 'est', 'un', 'une', 'du', 'que', 'pour', 'dans', 'pas', 'sur', 'avec', 'vous', 'nous', 'qui'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'mit', 'auf', 'für', 'von', 'den', 'dem', 'ich', 'sie', 'es'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'em', 'um', 'uma', 'para', 'com', 'não', 'você', 'do', 'da', 'mais', 'muito'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'untuk', 'dengan', 'tidak', 'dari', 'ke', 'akan', 'ada', 'saya', 'kita', 'bisa', 'juga'],
  tr: ['bir', 've', 'bu', 'için', 'ile', 'da', 'de', 'çok', 'ne', 'ben', 'sen', 'değil', 'daha', 'gibi'],
  it: ['il', 'lo', 'la', 'gli', 'che', 'di', 'e', 'un', 'una', 'per', 'con', 'non', 'sono', 'più', 'del', 'della', 'questo'],
};

// Bỏ link / @mention / #hashtag / $cashtag / số / emoji trước khi đoán ngôn ngữ (không mang thông tin ngôn ngữ).
function stripNoiseForLangDetect(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[@#$][\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Đoán mã ngôn ngữ từ chính nội dung (dùng khi X không gắn sẵn thuộc tính lang). Trả '' nếu không đủ dữ kiện.
function detectTextLanguageCode(rawText) {
  const t = stripNoiseForLangDetect(rawText);
  if (!t) return '';
  if (/[\u3040-\u30ff]/.test(t)) return 'ja';
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(t)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
  if (/[\u0e00-\u0e7f]/.test(t)) return 'th';
  if (/[\u0400-\u04ff]/.test(t)) return 'ru';
  if (/[\u0600-\u06ff]/.test(t)) return 'ar';
  if (/[\u0900-\u097f]/.test(t)) return 'hi';
  if (/[\u0590-\u05ff]/.test(t)) return 'he';

  const latinCount = (t.match(/\p{Script=Latin}/gu) || []).length;
  if (latinCount < 3) return '';

  // Tiếng Việt: các chữ có dấu thanh (khối U+1EA0-1EF9) và ă đ ơ ư gần như chỉ có ở Tiếng Việt.
  const viCount = (t.match(/[\u1EA0-\u1EF9ăđơưĂĐƠƯ]/g) || []).length;
  if (viCount >= 2 || (viCount >= 1 && latinCount < 25)) return 'vi';

  const words = t.toLowerCase().split(' ');
  let bestCode = 'en';
  let bestScore = 0;
  for (const [code, list] of Object.entries(LANG_STOPWORDS)) {
    const set = new Set(list);
    const score = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestCode = code; }
  }
  // Chữ Latin không có dấu đặc trưng và không khớp rõ ngôn ngữ nào -> mặc định Tiếng Anh (phổ biến nhất trên X).
  return bestScore >= 2 ? bestCode : 'en';
}

// Chuẩn hoá thuộc tính lang X gắn sẵn (vd "en", "zh-cn", "pt-BR"). Bỏ qua các mã đặc biệt của X
// (und = không xác định, qme/qht/qam/qst/qct/zxx = chỉ có mention/hashtag/emoji/link).
function normalizeXLangAttr(langAttr) {
  const raw = String(langAttr || '').toLowerCase().trim();
  if (!raw || raw === 'und' || raw === 'zxx' || /^q[a-z]{2}$/.test(raw)) return '';
  const base = raw.split('-')[0];
  return REPLY_LANG_NAMES[base] ? base : '';
}

function resolvePostLanguageCode(text, langAttr) {
  return normalizeXLangAttr(langAttr) || detectTextLanguageCode(text);
}

// Tạo chỉ dẫn ngôn ngữ cho prompt reply.
// - langChoice 'vi' / 'en': ép cứng.
// - 'auto' ("Theo Ngôn Ngữ bài đăng"): xác định ngôn ngữ thật của nội dung rồi ghi rõ tên ngôn ngữ.
// fallback* dùng khi nội dung chính quá ngắn/không xác định được (vd comment chỉ có emoji -> lấy theo bài gốc).
function buildReplyLangInstruction(langChoice, text, langAttr, subject = 'bài đăng', fallbackText = '', fallbackLangAttr = '') {
  if (langChoice === 'vi') return 'NGÔN NGỮ REPLY: BẮT BUỘC trả lời bằng Tiếng Việt (bất kể nội dung gốc viết bằng ngôn ngữ nào).';
  if (langChoice === 'en') return 'REPLY LANGUAGE: You MUST reply in English only, regardless of the language of the original content. Do NOT use Vietnamese.';

  const code = resolvePostLanguageCode(text, langAttr) || resolvePostLanguageCode(fallbackText, fallbackLangAttr);
  if (code) {
    const name = REPLY_LANG_NAMES[code] || code;
    if (code === 'vi') return `NGÔN NGỮ REPLY: ${subject} được viết bằng Tiếng Việt nên BẮT BUỘC trả lời bằng Tiếng Việt.`;
    return `REPLY LANGUAGE (HIGHEST PRIORITY, overrides everything else): the ${subject === 'bình luận' ? 'comment' : 'post'} is written in ${name}. You MUST write the reply ONLY in ${name}. Do NOT write in Vietnamese. The fact that these instructions are written in Vietnamese is irrelevant - the reply language is ${name}.`;
  }
  return 'REPLY LANGUAGE (HIGHEST PRIORITY, overrides everything else): first identify the language the content below is written in, then reply ONLY in that exact same language. Do NOT default to Vietnamese - the fact that these instructions are written in Vietnamese is irrelevant to the reply language. Only reply in Vietnamese if the content itself is Vietnamese.';
}

// Trả về TẤT CẢ ảnh đang được chọn ở 1 thư viện (mảng dataURL, theo đúng thứ tự hiển thị).
// Dùng cho Logo & Nhân vật - 2 mục này chọn được nhiều ảnh (nhân vật phụ, biến thể logo).
async function getActiveGalleryImages(storageKey) {
  const store = await chrome.storage.local.get([storageKey]);
  const list = store[storageKey] || [];
  const selected = list.filter((x) => x.selected).map((x) => x.dataUrl).filter(Boolean);
  if (selected.length > 0) return selected;
  // Chọn-nhiều-ảnh hỗ trợ "không chọn ảnh nào" -> trả mảng rỗng, KHÔNG fallback list[0].
  if (isMultiSelectMedia(storageKey)) return [];
  return list[0]?.dataUrl ? [list[0].dataUrl] : [];
}

async function getActiveGalleryImage(storageKey) {
  const store = await chrome.storage.local.get([storageKey]);
  const list = store[storageKey] || [];
  const selected = list.find((x) => x.selected);
  if (selected) return selected.dataUrl;
  // logoLibrary/charLibrary hỗ trợ "bỏ chọn" (không dùng ảnh nào) - KHÔNG fallback về
  // list[0] như trước, nếu không việc bỏ chọn ở gallery.addEventListener('click', ...)
  // phía trên sẽ vô tác dụng (vẫn tự lấy lại ảnh đầu tiên).
  if (storageKey === 'logoLibrary' || storageKey === 'charLibrary') return null;
  return list[0]?.dataUrl || null;
}

// ============== CONTENT CRYPTO: QUÉT TIN (X + RSS) -> AI VIẾT LẠI THEO GIỌNG CỦA TÔI -> ĐĂNG X ==============
const CRYPTO_DEFAULTS = {
  enabled: false, pollMinutes: 60, accounts: '', feeds: '', websiteUrls: '', restMinutes: 1, focus: '',
  keywordsExclude: 'giveaway, airdrop, follow + rt, whitelist, referral',
  persona: '', voiceSamples: '', voiceSampleList: [], language: 'Tiếng Việt', extraRules: '',
  maxPostsPerDay: 8, maxChars: 270, addSourceLink: false, copyImage: true, draftMode: true,
};
// [id ô nhập, khoá trong cryptoCfg]
const CRYPTO_TEXT_FIELDS = [
  ['cryptoWebsiteUrls', 'websiteUrls'], ['cryptoRestMinutes', 'restMinutes'],
  ['cryptoFocus', 'focus'],
  ['cryptoKwExclude', 'keywordsExclude'],
  ['cryptoPersona', 'persona'], ['cryptoLanguage', 'language'],
  ['cryptoExtraRules', 'extraRules'], ['cryptoMaxChars', 'maxChars'], ['cryptoPollInput', 'pollMinutes'],
  ['cryptoMaxPerDay', 'maxPostsPerDay'],
];

// Kho bài mẫu Content Crypto: MẢNG (mỗi phần tử = 1 bài nguyên vẹn, giữ nguyên xuống dòng) - cùng logic với
// kho bài mẫu của Nhiệm vụ. Lưu ở cryptoCfg.voiceSampleList. Dữ liệu cũ (chuỗi voiceSamples ngăn bằng ---)
// được tự tách thành từng mục khi mở lên.
let cryptoSamples = [];

function cryptoSamplesFromCfg(cfg) {
  if (Array.isArray(cfg && cfg.voiceSampleList) && cfg.voiceSampleList.length) {
    return cfg.voiceSampleList.map(normalizeSampleText).filter((t) => t.trim());
  }
  const legacy = normalizeSampleText((cfg && cfg.voiceSamples) || '');
  return legacy.split(/\n\s*-{3,}\s*\n/).map((s) => s.trim()).filter(Boolean);
}

function cryptoRefreshSampleUi(note) {
  const st = document.getElementById('cryptoSampleStatus');
  if (st) st.innerText = (note ? note + ' ' : '') + sampleStatusText({ samples: cryptoSamples });
  const box = document.getElementById('cryptoSampleList');
  if (box) box.innerHTML = sampleListHtml({ samples: cryptoSamples });
}

// Ô "Nguồn tin" gộp: link http(s) không phải x.com/twitter.com = RSS; còn lại (kể cả @user, link x.com/user) = tài khoản X.
function cryptoSplitSources(text) {
  const accounts = [];
  const feeds = [];
  String(text || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).forEach((line) => {
    if (/^https?:\/\//i.test(line) && !/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(line)) feeds.push(line);
    else accounts.push(line);
  });
  return { accounts: accounts.join('\n'), feeds: feeds.join('\n') };
}

function cryptoFillForm(saved) {
  const cfg = { ...CRYPTO_DEFAULTS, ...(saved || {}) };
  CRYPTO_TEXT_FIELDS.forEach(([id, key]) => { document.getElementById(id).value = cfg[key] === undefined ? '' : cfg[key]; });
  document.getElementById('cryptoSources').value = [cfg.accounts, cfg.feeds].map((s) => String(s || '').trim()).filter(Boolean).join('\n');
  document.getElementById('cryptoAutoToggle').checked = !!cfg.enabled;
  document.getElementById('cryptoSourceLinkToggle').checked = !!cfg.addSourceLink;
  document.getElementById('cryptoCopyImageToggle').checked = cfg.copyImage !== false;
  document.getElementById('cryptoDraftToggle').checked = cfg.draftMode !== false;
  cryptoSamples = cryptoSamplesFromCfg(cfg);
  cryptoRefreshSampleUi();
}

function cryptoReadForm() {
  const cfg = {};
  CRYPTO_TEXT_FIELDS.forEach(([id, key]) => { cfg[key] = document.getElementById(id).value.trim(); });
  Object.assign(cfg, cryptoSplitSources(document.getElementById('cryptoSources').value));
  cfg.enabled = document.getElementById('cryptoAutoToggle').checked;
  cfg.addSourceLink = document.getElementById('cryptoSourceLinkToggle').checked;
  cfg.copyImage = document.getElementById('cryptoCopyImageToggle').checked;
  cfg.draftMode = document.getElementById('cryptoDraftToggle').checked;
  cfg.voiceSampleList = cryptoSamples.slice();
  cfg.voiceSamples = ''; // chuỗi cũ đã được chuyển sang voiceSampleList
  return cfg;
}

function refreshCryptoNextRunText() {
  const el = document.getElementById('cryptoNextRunText');
  if (!el) return;
  chrome.alarms.get('ndan_crypto_poll').then((a) => {
    el.innerText = a ? `Lần quét kế tiếp: ${new Date(a.scheduledTime).toLocaleString('vi-VN')}` : 'Chưa bật tự động quét.';
  }).catch(() => {});
}

function setCryptoStatus(text) {
  const el = document.getElementById('cryptoStatusText');
  if (el) el.innerText = text;
}

async function saveCryptoSettingsAndApply(silent) {
  const cfg = cryptoReadForm();
  await chrome.storage.local.set({ cryptoCfg: cfg });
  const res = await chrome.runtime.sendMessage({ action: 'CRYPTO_APPLY_SCHEDULE' }).catch((e) => ({ success: false, error: e.message }));
  if (res && res.success === false) { showSavedToast(`Lỗi đặt lịch: ${res.error}`); return; }
  if (!silent) showSavedToast(cfg.enabled ? 'Đã lưu & bật Content Crypto tự động' : 'Đã lưu cài đặt Content Crypto');
  refreshCryptoNextRunText();
}

function renderCryptoDrafts(drafts) {
  const card = document.getElementById('cryptoDraftsCard');
  const box = document.getElementById('cryptoDrafts');
  if (!card || !box) return;
  const list = Array.isArray(drafts) ? drafts : [];
  card.style.display = list.length ? '' : 'none';
  box.innerHTML = list.map((dr) => `
    <div class="crypto-draft" data-id="${escapeHtml(dr.id)}" style="border-top:1px solid var(--border, #2a2f3a);padding-top:10px;margin-top:10px;">
      <p class="hint-text" style="margin:0 0 6px;">Từ ${escapeHtml(dr.source || '')} · ${new Date(dr.ts || Date.now()).toLocaleString('vi-VN')}${dr.url ? ` · <a href="${escapeHtml(dr.url)}" target="_blank" rel="noopener">xem nguồn</a>` : ''}</p>
      ${(Array.isArray(dr.images) && dr.images.length ? dr.images : (dr.image ? [dr.image] : [])).length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;">${(Array.isArray(dr.images) && dr.images.length ? dr.images : [dr.image]).slice(0, 4).map((u) => `<img src="${escapeHtml(u)}" alt="Ảnh từ bài gốc" style="max-width:48%;max-height:120px;border-radius:6px;">`).join('')}</div>` : ''}
      <textarea class="crypto-draft-text" style="min-height:90px;">${escapeHtml(dr.text || '')}</textarea>
      <p class="hint-text crypto-draft-count" style="margin:4px 0;">${(dr.text || '').length} ký tự</p>
      <div class="btn-row">
        <button type="button" class="btn btn-run crypto-draft-post">Đăng bài này</button>
        <button type="button" class="btn btn-run btn-run-stop crypto-draft-del">Xoá</button>
      </div>
    </div>`).join('');
}

async function loadCryptoDrafts() {
  const s = await chrome.storage.local.get('cryptoDrafts');
  renderCryptoDrafts(s.cryptoDrafts);
}

function setCryptoBusy(busy) {
  ['btnCryptoRun'].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = busy; });
}

// Xin quyền truy cập các trang RSS đã nhập (optional_host_permissions). Phải gọi ngay trong lúc bấm nút
// (cần thao tác người dùng); đã cấp 1 lần thì lượt chạy tự động sau này không cần hỏi lại.
async function cryptoEnsureFeedPermissions() {
  const origins = [];
  String([cryptoSplitSources(document.getElementById('cryptoSources').value).feeds, document.getElementById('cryptoWebsiteUrls').value].filter(Boolean).join('\n')).split(/[\n,;]+/).forEach((raw) => {
    try {
      const u = new URL(raw.trim());
      if (u.protocol === 'https:') { const o = `${u.origin}/*`; if (!origins.includes(o)) origins.push(o); }
    } catch (e) { /* bỏ qua dòng không phải link */ }
  });
  if (!origins.length) return true;
  try {
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch (e) {
    return false;
  }
}

async function runCrypto() {
  const dryRun = document.getElementById('cryptoDraftToggle').checked;
  const granted = await cryptoEnsureFeedPermissions();
  if (!granted) setCryptoStatus('Bạn chưa cho phép truy cập trang RSS - tin web sẽ không tải được (tin từ X vẫn chạy).');
  await saveCryptoSettingsAndApply(true);
  setCryptoBusy(true);
  setCryptoStatus(dryRun ? 'Đang chạy thử...' : 'Đang quét & đăng...');
  const res = await chrome.runtime.sendMessage({ action: 'CRYPTO_RUN_NOW', dryRun }).catch((e) => ({ success: false, error: e.message }));
  setCryptoBusy(false);
  if (res && res.success) {
    const st = res.stats;
    setCryptoStatus(dryRun
      ? `Xong chạy thử: ${st.drafts} bản nháp (thu ${st.collected} tin, ${st.fresh} tin mới, ${st.failed} lỗi).`
      : `Xong: ${st.posted} đã đăng, ${st.skipped} bỏ qua, ${st.failed} lỗi (thu ${st.collected} tin, ${st.fresh} tin mới).`);
  } else {
    setCryptoStatus(`Lỗi: ${res ? res.error : 'không rõ'}`);
  }
  loadCryptoDrafts();
  flushScheduledPostLog();
}

function bindCryptoControls() {
  CRYPTO_TEXT_FIELDS.map(([id]) => id).concat(['cryptoSources', 'cryptoAutoToggle', 'cryptoSourceLinkToggle', 'cryptoCopyImageToggle', 'cryptoDraftToggle']).forEach((id) => {
    document.getElementById(id).addEventListener('change', () => saveCryptoSettingsAndApply(false));
  });
  // ----- Kho bài mẫu (giống Nhiệm vụ): Thêm / Xem-Ẩn / Xoá từng bài / Xoá hết -----
  document.getElementById('btnCryptoSampleAdd').addEventListener('click', async () => {
    const ta = document.getElementById('cryptoSample');
    const text = normalizeSampleText(ta.value).replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!text.trim()) { cryptoRefreshSampleUi('Ô dán đang trống.'); return; }
    const exists = cryptoSamples.some((t) => t.trim() === text.trim());
    if (!exists) cryptoSamples = [...cryptoSamples, text];
    ta.value = '';
    cryptoRefreshSampleUi(exists ? 'Bài này đã có trong kho.' : 'Đã thêm.');
    await saveCryptoSettingsAndApply(true);
  });
  document.getElementById('btnCryptoSampleToggle').addEventListener('click', (e) => {
    const show = document.getElementById('cryptoSamplePanel').classList.toggle('hidden') === false;
    e.target.textContent = show ? 'Ẩn' : 'Xem';
  });
  document.getElementById('cryptoSampleList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.m-sample-del');
    if (!btn) return;
    cryptoSamples = cryptoSamples.filter((_, k) => k !== Number(btn.dataset.i));
    cryptoRefreshSampleUi('Đã xoá.');
    await saveCryptoSettingsAndApply(true);
  });
  document.getElementById('btnCryptoSampleClear').addEventListener('click', async () => {
    if (!confirm('Xoá toàn bộ bài mẫu đã lưu của Content Crypto?')) return;
    cryptoSamples = [];
    cryptoRefreshSampleUi('Đã xoá hết.');
    await saveCryptoSettingsAndApply(true);
  });
  document.getElementById('btnCryptoRun').addEventListener('click', () => runCrypto());
  document.getElementById('btnCryptoStop').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ action: 'CRYPTO_STOP' }).catch(() => null);
    setCryptoStatus(res && res.running ? 'Đã gửi yêu cầu dừng, sẽ dừng sau bước đang chạy...' : 'Hiện không có lượt nào đang chạy.');
  });

  const box = document.getElementById('cryptoDrafts');
  box.addEventListener('input', (e) => {
    if (!e.target.classList.contains('crypto-draft-text')) return;
    const cnt = e.target.closest('.crypto-draft').querySelector('.crypto-draft-count');
    cnt.innerText = `${e.target.value.length} ký tự`;
  });
  box.addEventListener('click', async (e) => {
    const wrap = e.target.closest('.crypto-draft');
    if (!wrap) return;
    const id = wrap.dataset.id;
    if (e.target.classList.contains('crypto-draft-del')) {
      const s = await chrome.storage.local.get('cryptoDrafts');
      const left = (s.cryptoDrafts || []).filter((x) => x.id !== id);
      await chrome.storage.local.set({ cryptoDrafts: left });
      renderCryptoDrafts(left);
      return;
    }
    if (e.target.classList.contains('crypto-draft-post')) {
      const text = wrap.querySelector('.crypto-draft-text').value.trim();
      e.target.disabled = true;
      setCryptoStatus('Đang đăng bản nháp...');
      const res = await chrome.runtime.sendMessage({ action: 'CRYPTO_POST_DRAFT', id, text }).catch((er) => ({ success: false, error: er.message }));
      setCryptoStatus(res && res.success ? 'Đã đăng bản nháp.' : `Lỗi: ${res ? res.error : 'không rõ'}`);
      loadCryptoDrafts();
      flushScheduledPostLog();
    }
  });
}

// ============== QUÉT CHATGPT TASKS -> ĐĂNG X ==============
function refreshChatgptNextRunText() {
  const el = document.getElementById('chatgptNextRunText');
  if (!el) return;
  chrome.alarms.get('ndan_chatgpt_poll').then((a) => {
    el.innerText = a ? `Lần quét kế tiếp: ${new Date(a.scheduledTime).toLocaleString('vi-VN')}` : 'Chưa bật tự động quét.';
  }).catch(() => {});
}

async function saveChatgptSettingsAndApply() {
  const enabled = document.getElementById('chatgptAutoToggle').checked;
  await chrome.storage.local.set({
    chatgptAutoEnabled: enabled,
    chatgptPollMinutes: document.getElementById('chatgptPollInput').value.trim(),
    chatgptTaskName: document.getElementById('chatgptTaskNameInput').value.trim(),
    chatgptPostGapMin: document.getElementById('chatgptPostGapInput').value.trim(),
  });
  const res = await chrome.runtime.sendMessage({ action: 'CHATGPT_APPLY_SCHEDULE' }).catch((e) => ({ success: false, error: e.message }));
  if (res && res.success === false) { showSavedToast(`Lỗi đặt lịch: ${res.error}`); return; }
  showSavedToast(enabled ? 'Đã lưu & bật quét ChatGPT tự động' : 'Đã lưu cài đặt quét ChatGPT');
  refreshChatgptNextRunText();
}

function bindChatgptControls() {
  ['chatgptAutoToggle', 'chatgptPollInput', 'chatgptTaskNameInput', 'chatgptPostGapInput'].forEach((id) => {
    document.getElementById(id).addEventListener('change', saveChatgptSettingsAndApply);
  });
  document.getElementById('btnChatgptRunNow').addEventListener('click', async () => {
    const btn = document.getElementById('btnChatgptRunNow');
    await saveChatgptSettingsAndApply();
    btn.disabled = true;
    setChatgptStatus('Đang quét ChatGPT...');
    const res = await chrome.runtime.sendMessage({ action: 'CHATGPT_RUN_NOW' }).catch((e) => ({ success: false, error: e.message }));
    btn.disabled = false;
    if (res && res.success) {
      const st = res.stats;
      setChatgptStatus(`Xong: ${st.posted} đã đăng, ${st.skipped} trùng, ${st.failed} lỗi (tìm thấy ${st.found} bài).`);
    } else {
      setChatgptStatus(`Lỗi: ${res ? res.error : 'không rõ'}`);
    }
    flushScheduledPostLog();
  });
}

function setChatgptStatus(text) {
  const el = document.getElementById('chatgptStatusText');
  if (el) el.innerText = text;
}

// ============== NHIỆM VỤ (TỰ ĐỘNG HOÁ) ==============
let missions = [];

function missionGenId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Kho bài mẫu của nhiệm vụ là MẢNG (m.samples): mỗi phần tử là 1 bài nguyên vẹn, giữ nguyên mọi
// chỗ xuống dòng/dòng trống bên trong bài - không còn tách bài bằng "dòng trống" như trước.
// Chuẩn hoá mọi kiểu ký tự xuống dòng (CRLF, CR, U+2028, U+2029, NEL, VT, FF) về "\\n". Nội dung copy từ web/X/Grok
// đôi khi dùng ký tự ngắt dòng "lạ" (U+2028...): nhìn trong ô dán vẫn xuống dòng nhưng KHÔNG phải "\\n" nên
// preview không thấy ngắt dòng và AI cũng không nhận ra bài có xuống dòng.
function normalizeSampleText(t) {
  return String(t || '').replace(/\r\n|\r|\u2028|\u2029|\u0085|\u000b|\u000c/g, '\n');
}

function missionSamplesOf(m) {
  if (Array.isArray(m && m.samples)) return m.samples.map(normalizeSampleText).filter((t) => t.trim());
  // Dữ liệu cũ (chuỗi sampleText): coi cả khối là 1 mục, người dùng có thể xoá/thêm lại cho đúng.
  const legacy = normalizeSampleText((m && m.sampleText) || '').trim();
  return legacy ? [legacy] : [];
}

function sampleStatusText(m) {
  const n = missionSamplesOf(m).length;
  return n ? `Đã lưu ${n} bài mẫu.` : 'Chưa có bài mẫu nào được lưu.';
}

function sampleListHtml(m) {
  return missionSamplesOf(m).map((t, i) => {
    const lines = t.split('\n').length;
    return `<div class="sample-item" style="display:flex;gap:6px;align-items:flex-start;margin-top:6px;">
      <div class="hint-text" style="flex:1;margin:0;white-space:pre-wrap;max-height:7em;overflow:auto;border-left:2px solid rgba(128,128,128,.4);padding-left:6px;"><span style="opacity:.6;">${i + 1}. [${lines} dòng]</span>\n${escapeHtml(t)}</div>
      <button type="button" class="btn btn-run-stop m-sample-del" data-i="${i}" style="padding:2px 8px;font-size:12px;">✕</button>
    </div>`;
  }).join('');
}

// Chu kỳ đăng: random trong khoảng [min, max] GIỜ. Dữ liệu cũ (intervalHours = 1/2/3) -> min = max = giá trị đó.
function missionRangeOf(m) {
  let lo = Number(m && m.intervalMinHours), hi = Number(m && m.intervalMaxHours);
  if (!(lo > 0) || !(hi > 0)) {
    const h = Number(m && m.intervalHours);
    if ([1, 2, 3].includes(h)) { lo = hi = h; } else { lo = 1; hi = 3; }
  }
  lo = Math.max(5 / 60, lo); hi = Math.max(5 / 60, hi);
  if (lo > hi) [lo, hi] = [hi, lo];
  return [lo, hi];
}

function missionRangeText(m) {
  const [lo, hi] = missionRangeOf(m);
  const f = (x) => String(Math.round(x * 100) / 100).replace('.', ',');
  return lo === hi ? `mỗi ${f(lo)} giờ` : `ngẫu nhiên từ ${f(lo)} đến ${f(hi)} giờ`;
}

function missionIdleText(m) {
  return m.enabled ? `Đang chạy liên tục - đăng ${missionRangeText(m)}.` : 'Đang tắt.';
}

function missionCardHtml(m) {
  return `
    <div class="card mission-card" data-id="${m.id}" style="margin-top:10px;">
      <div class="form-group">
        <label>Tên nhiệm vụ</label>
        <input type="text" class="m-name" value="${escapeHtml(m.name || '')}" placeholder="Ví dụ: KOL Ăn uống - Gym - Du lịch">
      </div>
      <div class="form-group">
        <label>Tên nhân vật (persona) - tuỳ chọn, AI dùng khi bài cần xưng tên/ký tên</label>
        <input type="text" class="m-persona-name" value="${escapeHtml(m.personaName || '')}" placeholder="Ví dụ: Linz">
      </div>
      <div class="form-group">
        <label>Giới tính (đưa vào prompt ảnh: "đây là tôi, giới tính ...")</label>
        <div class="chip-group">
          <button type="button" class="chip option-chip m-gender ${m.gender === 'male' ? 'active' : ''}" data-val="male">Nam</button>
          <button type="button" class="chip option-chip m-gender ${m.gender === 'female' ? 'active' : ''}" data-val="female">Nữ</button>
        </div>
      </div>
      <div class="form-group">
        <label>Quốc gia (để ảnh đúng bối cảnh quốc gia đó) - tuỳ chọn</label>
        <input type="text" class="m-country" value="${escapeHtml(m.country || '')}" placeholder="Ví dụ: Việt Nam">
      </div>
      <div class="form-group">
        <label>Vai trò (persona) giao cho AI</label>
        <textarea class="m-persona" placeholder="Ví dụ: Bạn sẽ trở thành 1 KOL chuyên tư vấn ăn uống khoẻ mạnh, gym và du lịch...">${escapeHtml(m.persona || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Tâm trạng ngẫu nhiên (tuỳ chọn) - mỗi dòng 1 trạng thái, thỉnh thoảng AI sẽ viết bài mang tâm trạng đó</label>
        <textarea class="m-moods" placeholder="Ví dụ:&#10;buồn vô cớ&#10;thấy cô đơn&#10;hơi mệt mỏi, muốn ở một mình">${escapeHtml(m.moods || '')}</textarea>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <span class="hint-text" style="margin:0;">Tỉ lệ bài có tâm trạng (%):</span>
          <input type="text" class="m-mood-chance" inputmode="numeric" value="${m.moodChance === undefined || m.moodChance === '' ? 25 : escapeHtml(String(m.moodChance))}" style="width:70px;" placeholder="25">
        </div>
      </div>
      <div class="form-group">
        <label>Bài đăng mẫu (tuỳ chọn - mỗi lần dán 1 bài nguyên vẹn kể cả xuống dòng, bấm Thêm để lưu; ô này sẽ tự làm trống)</label>
        <textarea class="m-sample" placeholder="Dán 1 bài mẫu vào đây (có thể nhiều dòng), rồi bấm Thêm..."></textarea>
        <button type="button" class="btn btn-run m-sample-add" style="margin-top:6px;padding:4px 12px;font-size:12px;">+ Thêm bài mẫu</button>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <p class="hint-text m-sample-status" style="margin:0;flex:1;">${sampleStatusText(m)}</p>
          <button type="button" class="btn m-sample-toggle" style="padding:2px 12px;font-size:12px;">Xem</button>
        </div>
        <div class="m-sample-panel hidden">
          <div class="m-sample-list">${sampleListHtml(m)}</div>
          <button type="button" class="btn btn-run-stop m-sample-clear" style="margin-top:6px;padding:4px 10px;font-size:12px;">Xoá hết bài mẫu đã lưu</button>
        </div>
      </div>
      <div class="form-group">
        <label>Media đính kèm</label>
        <div class="chip-group m-mediatype-group">
          <button type="button" class="chip option-chip m-mediatype ${(!m.mediaType || m.mediaType === 'none') ? 'active' : ''}" data-val="none">Không có</button>
          <button type="button" class="chip option-chip m-mediatype ${m.mediaType === 'image' ? 'active' : ''}" data-val="image">Ảnh (ChatGPT/Gemini)</button>
          <button type="button" class="chip option-chip m-mediatype ${m.mediaType === 'video' ? 'active' : ''}" data-val="video">Video (ảnh → Grok Imagine)</button>
        </div>
      </div>
      <div class="form-group m-imagesource-group ${(m.mediaType === 'image' || m.mediaType === 'video') ? '' : 'hidden'}">
        <label>Nguồn tạo ảnh (với Video: đây là ảnh gốc để Grok biến thành video)</label>
        <div class="chip-group">
          <button type="button" class="chip option-chip m-imagesource ${(!m.imageSource || m.imageSource === 'chatgpt') ? 'active' : ''}" data-val="chatgpt">ChatGPT</button>
          <button type="button" class="chip option-chip m-imagesource ${m.imageSource === 'gemini' ? 'active' : ''}" data-val="gemini">Gemini</button>
        </div>
        <label style="margin-top:10px;">Kiểu ảnh</label>
        <div class="chip-group">
          <button type="button" class="chip option-chip m-shotmode ${(!m.shotMode || m.shotMode === 'auto') ? 'active' : ''}" data-val="auto">Tự động (AI chọn từng bài)</button>
          <button type="button" class="chip option-chip m-shotmode ${m.shotMode === 'person' ? 'active' : ''}" data-val="person">Luôn có nhân vật</button>
          <button type="button" class="chip option-chip m-shotmode ${m.shotMode === 'no_person' ? 'active' : ''}" data-val="no_person">Không nhân vật</button>
        </div>
      </div>
      <div class="form-group">
        <label>Chu kỳ đăng bài: random từ giờ X - Y (mỗi lần đăng xong, bài kế tiếp hẹn ngẫu nhiên trong khoảng này)</label>
        <div class="kol-input-row">
          <input type="text" class="m-int-min" inputmode="decimal" value="${missionRangeOf(m)[0]}" placeholder="Từ (giờ), vd: 1">
          <input type="text" class="m-int-max" inputmode="decimal" value="${missionRangeOf(m)[1]}" placeholder="Đến (giờ), vd: 3">
        </div>
      </div>
      <p class="hint-text m-status">${missionIdleText(m)}</p>
      <div class="btn-row">
        <button type="button" class="btn btn-run m-run">Chạy</button>
        <button type="button" class="btn btn-run-stop m-delete">Xoá nhiệm vụ</button>
      </div>
    </div>`;
}

function renderMissions() {
  const el = document.getElementById('missionsList');
  if (!el) return;
  el.innerHTML = missions.length ? missions.map(missionCardHtml).join('') : '<p class="hint-text">Chưa có nhiệm vụ nào. Bấm "+ Thêm nhiệm vụ" bên dưới.</p>';
  refreshMissionsRunningState();
}

function missionFromCard(card) {
  return {
    id: card.dataset.id,
    enabled: !!(missions.find((m) => m.id === card.dataset.id) || {}).enabled, // bật/tắt bằng nút Chạy/Dừng
    ...(() => {
      const num = (sel) => Number(String(card.querySelector(sel)?.value || '').replace(',', '.'));
      const [lo, hi] = missionRangeOf({ intervalMinHours: num('.m-int-min'), intervalMaxHours: num('.m-int-max'), intervalHours: 0 });
      return { intervalMinHours: lo, intervalMaxHours: hi, intervalHours: 0 };
    })(),
    name: card.querySelector('.m-name').value.trim(),
    personaName: card.querySelector('.m-persona-name').value.trim(),
    gender: card.querySelector('.m-gender.active')?.dataset.val || '',
    country: card.querySelector('.m-country').value.trim(),
    persona: card.querySelector('.m-persona').value.trim(),
    moods: card.querySelector('.m-moods').value.trim(),
    moodChance: (() => {
      const raw = String(card.querySelector('.m-mood-chance').value || '').replace(',', '.').trim();
      const n = Number(raw);
      return raw === '' || !isFinite(n) ? 25 : Math.min(100, Math.max(0, Math.round(n)));
    })(),
    samples: missionSamplesOf(missions.find((m) => m.id === card.dataset.id) || {}),
    sampleText: '',
    mediaType: card.querySelector('.m-mediatype.active')?.dataset.val || 'none',
    imageSource: card.querySelector('.m-imagesource.active')?.dataset.val || 'chatgpt',
    shotMode: card.querySelector('.m-shotmode.active')?.dataset.val || 'auto',
    slotsText: (missions.find((m) => m.id === card.dataset.id) || {}).slotsText || '', // không còn dùng (giữ để tương thích dữ liệu cũ)
  };
}

async function saveMissions() {
  await chrome.storage.local.set({ missions });
  const res = await chrome.runtime.sendMessage({ action: 'MISSION_APPLY_SCHEDULE' }).catch((e) => ({ success: false, error: e.message }));
  if (res && res.success === false) showSavedToast(`Lỗi đặt lịch nhiệm vụ: ${res.error}`);
  else showSavedToast('Đã lưu nhiệm vụ');
}

// Đặt nút Chạy/Dừng của 1 thẻ nhiệm vụ theo đúng trạng thái đang chạy hay không.
function setMissionCardRunState(card, running) {
  const btn = card.querySelector('.m-run');
  if (!btn) return;
  btn.disabled = false;
  if (running) {
    btn.textContent = 'Dừng';
    btn.classList.remove('btn-run');
    btn.classList.add('btn-run-stop');
    btn.dataset.state = 'running';
  } else {
    btn.textContent = 'Chạy';
    btn.classList.remove('btn-run-stop');
    btn.classList.add('btn-run');
    btn.dataset.state = 'idle';
  }
}

// Hỏi background.js xem đang có nhiệm vụ nào chạy không (kể cả do hẹn giờ tự kích hoạt,
// không phải do bấm "Chạy thử ngay" ở panel này) - để mở lại panel vẫn thấy đúng trạng thái.
function refreshMissionsRunningState() {
  document.querySelectorAll('.mission-card').forEach((card) => {
    const m = missions.find((x) => x.id === card.dataset.id);
    setMissionCardRunState(card, !!(m && m.enabled));
  });
}

function bindMissionsList() {
  const list = document.getElementById('missionsList');
  if (!list) return;

  const syncCardToState = (card) => {
    const idx = missions.findIndex((m) => m.id === card.dataset.id);
    if (idx === -1) return;
    missions[idx] = missionFromCard(card);
    const statusEl = card.querySelector('.m-status');
    if (statusEl) statusEl.innerText = missionIdleText(missions[idx]);
  };

  // Cập nhật phần hiển thị bài mẫu của 1 thẻ sau khi kho thay đổi.
  const refreshSampleUi = (card, m, note) => {
    const st = card.querySelector('.m-sample-status');
    if (st) st.innerText = (note ? note + ' ' : '') + sampleStatusText(m);
    const box = card.querySelector('.m-sample-list');
    if (box) box.innerHTML = sampleListHtml(m);
  };

  // Thêm NGUYÊN nội dung ô dán (1 bài, giữ nguyên xuống dòng) vào kho, lưu chrome.storage.local, rồi làm trống ô.
  const addSampleToMission = (card) => {
    const idx = missions.findIndex((m) => m.id === card.dataset.id);
    if (idx === -1) return;
    const ta = card.querySelector('.m-sample');
    const text = normalizeSampleText(ta.value).replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!text.trim()) { refreshSampleUi(card, missions[idx], 'Ô dán đang trống.'); return; }
    const cur = missionFromCard(card);
    const exists = cur.samples.some((t) => t.trim() === text.trim());
    if (!exists) cur.samples = [...cur.samples, text];
    missions[idx] = cur;
    ta.value = '';
    refreshSampleUi(card, cur, exists ? 'Bài này đã có trong kho.' : 'Đã thêm.');
    saveMissions();
  };

  list.addEventListener('change', (e) => {
    const card = e.target.closest('.mission-card');
    if (!card) return;
    if (e.target.classList.contains('m-sample')) return; // chỉ lưu khi bấm nút "+ Thêm bài mẫu"
    syncCardToState(card);
    saveMissions();
  });

  list.addEventListener('click', (e) => {
    const card = e.target.closest('.mission-card');
    if (!card) return;

    if (e.target.classList.contains('m-mediatype')) {
      card.querySelectorAll('.m-mediatype').forEach((c) => c.classList.remove('active'));
      e.target.classList.add('active');
      card.querySelector('.m-imagesource-group').classList.toggle('hidden', !['image', 'video'].includes(e.target.dataset.val));
      syncCardToState(card);
      saveMissions();
      return;
    }
    if (e.target.classList.contains('m-gender')) {
      const wasActive = e.target.classList.contains('active');
      card.querySelectorAll('.m-gender').forEach((c) => c.classList.remove('active'));
      if (!wasActive) e.target.classList.add('active'); // bấm lại lần nữa = bỏ chọn
      syncCardToState(card);
      saveMissions();
      return;
    }
    if (e.target.classList.contains('m-shotmode')) {
      card.querySelectorAll('.m-shotmode').forEach((c) => c.classList.remove('active'));
      e.target.classList.add('active');
      syncCardToState(card);
      saveMissions();
      return;
    }
    if (e.target.classList.contains('m-imagesource')) {
      card.querySelectorAll('.m-imagesource').forEach((c) => c.classList.remove('active'));
      e.target.classList.add('active');
      syncCardToState(card);
      saveMissions();
      return;
    }
    if (e.target.classList.contains('m-sample-toggle')) {
      const panel = card.querySelector('.m-sample-panel');
      if (!panel) return;
      const show = panel.classList.toggle('hidden') === false;
      e.target.textContent = show ? 'Ẩn' : 'Xem';
      return;
    }
    if (e.target.classList.contains('m-sample-add')) {
      addSampleToMission(card);
      return;
    }
    if (e.target.classList.contains('m-sample-del')) {
      const i = missions.findIndex((m) => m.id === card.dataset.id);
      if (i === -1) return;
      const cur = missionFromCard(card);
      cur.samples = cur.samples.filter((_, k) => k !== Number(e.target.dataset.i));
      missions[i] = cur;
      refreshSampleUi(card, cur, 'Đã xoá.');
      saveMissions();
      return;
    }
    if (e.target.classList.contains('m-sample-clear')) {
      if (!confirm('Xoá toàn bộ bài mẫu đã lưu của nhiệm vụ này?')) return;
      const i = missions.findIndex((m) => m.id === card.dataset.id);
      if (i === -1) return;
      const cur = missionFromCard(card);
      cur.samples = [];
      missions[i] = cur;
      refreshSampleUi(card, cur, 'Đã xoá hết.');
      saveMissions();
      return;
    }
    if (e.target.classList.contains('m-delete')) {
      if (!confirm('Xoá nhiệm vụ này?')) return;
      const removedId = card.dataset.id;
      missions = missions.filter((m) => m.id !== removedId);
      renderMissions();
      saveMissions();
      chrome.storage.local.get('missionHistory').then(({ missionHistory }) => {
        if (!missionHistory || !(removedId in missionHistory)) return;
        delete missionHistory[removedId];
        chrome.storage.local.set({ missionHistory });
      });
      return;
    }
    if (e.target.classList.contains('m-run')) {
      const btn = e.target;
      const statusEl = card.querySelector('.m-status');
      const idx = missions.findIndex((m) => m.id === card.dataset.id);
      if (idx === -1) return;
      const cur = missionFromCard(card);

      // ĐANG CHẠY LIÊN TỤC -> DỪNG: tắt vòng lặp (xoá alarm) + dừng lượt đang chạy của CHÍNH nhiệm vụ này.
      if (btn.dataset.state === 'running') {
        cur.enabled = false;
        missions[idx] = cur;
        setMissionCardRunState(card, false);
        if (statusEl) statusEl.innerText = 'Đã dừng.';
        saveMissions();
        chrome.runtime.sendMessage({ action: 'MISSION_GET_RUNNING' }).then((res) => {
          if (res && res.success && res.runningId === cur.id) return chrome.runtime.sendMessage({ action: 'MISSION_STOP' });
        }).catch(() => {});
        return;
      }

      // BẮT ĐẦU CHẠY LIÊN TỤC: bật vòng lặp theo chu kỳ + đăng bài đầu tiên ngay.
      if (!cur.persona) {
        if (statusEl) statusEl.innerText = 'Hãy nhập Vai trò (persona) cho AI trước khi chạy.';
        return;
      }
      cur.enabled = true;
      missions[idx] = cur;
      setMissionCardRunState(card, true);
      if (statusEl) statusEl.innerText = `Đang chạy liên tục - đăng ${missionRangeText(cur)}. Đang tạo bài đầu tiên...`;
      saveMissions().then(() => chrome.runtime.sendMessage({ action: 'MISSION_RUN_NOW', missionId: cur.id })).then((res) => {
        if (res && res.success === false && statusEl) statusEl.innerText = `Đang chạy liên tục - đăng ${missionRangeText(cur)}. ${res.error || ''}`;
      }).catch((e2) => { if (statusEl) statusEl.innerText = `Lỗi: ${e2.message}`; });
    }
  });

  document.getElementById('btnAddMission').addEventListener('click', () => {
    missions.push({ id: missionGenId(), enabled: false, name: '', personaName: '', gender: '', country: '', persona: '', moods: '', moodChance: 25, samples: [], sampleText: '', mediaType: 'none', imageSource: 'chatgpt', shotMode: 'auto', intervalMinHours: 1, intervalMaxHours: 3, intervalHours: 0, slotsText: '' });
    renderMissions();
  });
}

// ============== TIỆN ÍCH DÙNG CHUNG ==============
function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============== TẠM DỪNG MỌI TÍNH NĂNG KHI TỚI GIỜ HẸN TẠO/ĐĂNG BÀI ==============
// Tương tác Home tạm dừng ngay khi bắt đầu tạo bài và tự chạy lại sau khi bài hẹn giờ
// chạy xong.
// - Tạm dừng "êm": chỉ tắt cờ đang chạy, để công việc dở dang chạy nốt cho xong rồi vòng
//   lặp tự thoát, không cắt ngang giữa chừng.
// - Chạy lại: tiếp đúng phần còn lại (Tương tác Home dùng lịch sử 7 ngày + khung giờ).
// - Người dùng tự bấm Dừng hoặc tự bấm Chạy trong lúc đang tạm dừng luôn được ưu tiên:
//   việc tự-chạy-lại của tính năng đó bị huỷ (cancelScheduleResume).

function pauseHomeInteractForSchedule() {
  isHomeInteractRunning = false;
  setHomeInteractStatus('Tới giờ hẹn đăng bài - tạm dừng...');
}

const SCHEDULE_PAUSABLE_FLOWS = [
  { key: 'homeInteract', label: 'Tương tác Home', channel: 'homeInteract', isRunning: () => isHomeInteractRunning, pause: pauseHomeInteractForSchedule, resume: () => runHomeInteractFlow() },
];

// Người dùng tự thao tác tay với 1 tính năng -> bỏ nó khỏi danh sách chờ tự-chạy-lại.
function cancelScheduleResume(key) {
  flowsPausedForSchedule.delete(key);
}

function pauseAllFlowsForSchedule() {
  SCHEDULE_PAUSABLE_FLOWS.forEach((f) => {
    if (!f.isRunning()) return;
    flowsPausedForSchedule.add(f.key);
    f.pause();
    // Ghi vào nhật ký RIÊNG của đúng tính năng bị tạm dừng (không còn 1 dòng gộp chung nhiều tính năng).
    logEvent(f.channel, 'Tới giờ hẹn đăng bài - tạm dừng (chạy nốt việc đang dở rồi dừng, sẽ tự tiếp tục khi đăng bài xong).', 'info');
  });
}

async function resumeAllFlowsAfterSchedule() {
  if (flowsPausedForSchedule.size === 0) return;
  const keys = Array.from(flowsPausedForSchedule);
  flowsPausedForSchedule.clear();

  // Chờ vài giây cho các vòng lặp vừa bị tắt cờ thoát hẳn + đóng tab của chúng, tránh
  // khởi động lại đúng lúc tab cũ chưa dọn xong.
  await wait(3000);

  keys.forEach((key) => {
    const flow = SCHEDULE_PAUSABLE_FLOWS.find((f) => f.key === key);
    if (!flow) return;
    if (flow.isRunning()) return;        // người dùng đã tự bấm Chạy lại trong lúc chờ
    logEvent(flow.channel, `Bài hẹn giờ đã xong - tự tiếp tục ${flow.label}.`, 'info');
    // KHÔNG await: nhiều tính năng chạy vòng lặp dài (có khi chạy suốt ngày theo khung
    // giờ), await sẽ chặn việc khởi động lại các tính năng còn lại.
    Promise.resolve()
      .then(() => flow.resume())
      .catch((e) => logEvent(flow.channel, `Không tự tiếp tục được ${flow.label}: ${e.message}`, 'error'));
  });
}

// Bài hẹn giờ đã đăng xong (thành công) -> tự tiếp tục Chéo Link đang tạm dừng, với 1
// khoảng nghỉ y hệt "thời gian nghỉ giữa các link" bình thường (ô Delay) trước khi thực
// sự xử lý link kế tiếp, để nhịp chạy tự nhiên giống hệt như đang chạy liên tục, chỉ là
// có 1 khoảng dừng xen giữa lúc bài hẹn giờ được đăng.
// ============== TƯƠNG TÁC HOME ==============
// Giống Reply Comment / Chéo Link (AI đọc bài -> soạn reply -> gửi, có delay, có Like tuỳ chọn) nhưng
// nguồn bài là TIMELINE HOME của X thay vì link: mở x.com/home, lần lượt lấy từng bài chưa xử lý
// (bỏ qua quảng cáo, bài của chính mình, bài không có chữ, bài thuộc ngôn ngữ bị chặn), reply ngay trên
// timeline. Lịch sử id bài đã reply được nhớ 7 ngày để không reply trùng 1 bài ở các lần chạy sau.
const HOME_INTERACT_HISTORY_KEY = 'homeInteractHistory';
const HOME_INTERACT_HISTORY_DAYS = 7;
const HOME_NO_POST_RETRY_SEC = 300; // trong khung giờ mà hết bài mới: chờ 5 phút rồi quét lại timeline

async function getHomeInteractHistory() {
  const store = await chrome.storage.local.get(HOME_INTERACT_HISTORY_KEY);
  const map = store[HOME_INTERACT_HISTORY_KEY] || {};
  const cutoff = Date.now() - HOME_INTERACT_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  Object.keys(map).forEach((id) => { if (map[id] < cutoff) delete map[id]; });
  return map;
}

async function markHomeInteracted(postId) {
  const map = await getHomeInteractHistory();
  map[postId] = Date.now();
  await chrome.storage.local.set({ [HOME_INTERACT_HISTORY_KEY]: map });
}

function homeInteractMessage(payload) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(payload, (r) => (r && r.success ? resolve(r) : reject(new Error(r?.error || 'Lỗi Tương tác Home')))));
}

function renderHomeInteractProgress(done, max) {
  document.getElementById('homeInteractProgressText').innerText = `Tiến độ: ${done}/${max} bài`;
  document.getElementById('homeInteractSuccessCount').innerText = homeInteractStats.success;
  document.getElementById('homeInteractFailCount').innerText = homeInteractStats.fail;
  document.getElementById('homeInteractRemainCount').innerText = Math.max(max - done, 0);
}

function setHomeInteractStatus(text) {
  document.getElementById('homeInteractStatusText').innerText = text;
}

// ---------- Bỏ qua bài theo ngôn ngữ ----------
// Người dùng gõ TÊN ngôn ngữ (tiếng Nhật, tiếng Hàn, Japanese...) hoặc mã (ja, ko) -> quy ra mã ngôn ngữ của X.
const SKIP_LANGUAGE_TABLE = [
  { label: 'Tiếng Nhật', codes: ['ja'], names: ['nhat', 'nhat ban', 'japanese', 'japan', 'ja', 'nihongo'] },
  { label: 'Tiếng Hàn', codes: ['ko'], names: ['han', 'han quoc', 'korean', 'korea', 'ko'] },
  { label: 'Tiếng Trung', codes: ['zh'], names: ['trung', 'trung quoc', 'trung van', 'hoa', 'tau', 'chinese', 'china', 'zh'] },
  { label: 'Tiếng Anh', codes: ['en'], names: ['anh', 'english', 'en'] },
  { label: 'Tiếng Việt', codes: ['vi'], names: ['viet', 'viet nam', 'vietnamese', 'vi'] },
  { label: 'Tiếng Thái', codes: ['th'], names: ['thai', 'thai lan', 'thailand', 'th'] },
  { label: 'Tiếng Indonesia', codes: ['in', 'id'], names: ['indonesia', 'indo', 'indonesian', 'id', 'in'] },
  { label: 'Tiếng Malaysia', codes: ['ms'], names: ['malay', 'malaysia', 'ma lai', 'ms'] },
  { label: 'Tiếng Nga', codes: ['ru'], names: ['nga', 'russian', 'russia', 'ru'] },
  { label: 'Tiếng Ukraina', codes: ['uk'], names: ['ukraina', 'ukraine', 'ukrainian', 'uk'] },
  { label: 'Tiếng Tây Ban Nha', codes: ['es'], names: ['tay ban nha', 'spanish', 'spain', 'es'] },
  { label: 'Tiếng Bồ Đào Nha', codes: ['pt'], names: ['bo dao nha', 'portuguese', 'brazil', 'pt'] },
  { label: 'Tiếng Pháp', codes: ['fr'], names: ['phap', 'french', 'fr'] },
  { label: 'Tiếng Đức', codes: ['de'], names: ['duc', 'german', 'de'] },
  { label: 'Tiếng Ý', codes: ['it'], names: ['y', 'italian', 'italy', 'it'] },
  { label: 'Tiếng Thổ Nhĩ Kỳ', codes: ['tr'], names: ['tho nhi ky', 'turkish', 'turkey', 'tr'] },
  { label: 'Tiếng Ả Rập', codes: ['ar'], names: ['a rap', 'arabic', 'ar'] },
  { label: 'Tiếng Hindi', codes: ['hi'], names: ['hindi', 'an do', 'india', 'hi'] },
  { label: 'Tiếng Ba Tư', codes: ['fa'], names: ['ba tu', 'farsi', 'persian', 'iran', 'fa'] },
  { label: 'Tiếng Do Thái', codes: ['he', 'iw'], names: ['do thai', 'hebrew', 'he', 'iw'] },
  { label: 'Tiếng Philippines', codes: ['tl', 'fil'], names: ['philippines', 'philipin', 'philippin', 'tagalog', 'filipino', 'tl', 'fil'] },
  { label: 'Tiếng Hà Lan', codes: ['nl'], names: ['ha lan', 'dutch', 'nl'] },
  { label: 'Tiếng Ba Lan', codes: ['pl'], names: ['ba lan', 'polish', 'pl'] },
  { label: 'Tiếng Bengal', codes: ['bn'], names: ['bengal', 'bangla', 'bn'] },
  { label: 'Tiếng Urdu', codes: ['ur'], names: ['urdu', 'ur'] },
];

function normalizeLangName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/^(tieng|ngon ngu|language)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSkipLanguages(text) {
  const parts = String(text || '').split(/[,;\n|/]+/).map((s) => s.trim()).filter(Boolean);
  const codes = new Set();
  const labels = [];
  const unknown = [];
  parts.forEach((p) => {
    const key = normalizeLangName(p);
    const entry = SKIP_LANGUAGE_TABLE.find((e) => e.names.includes(key));
    if (!entry) {
      unknown.push(p);
      return;
    }
    entry.codes.forEach((c) => codes.add(c));
    if (!labels.includes(entry.label)) labels.push(entry.label);
  });
  return { codes: Array.from(codes), labels, unknown };
}

function updateHomeSkipLangHint() {
  const input = document.getElementById('homeSkipLangInput');
  const hint = document.getElementById('homeSkipLangHint');
  if (!input || !hint) return;
  const { labels, unknown } = resolveSkipLanguages(input.value);
  const parts = [];
  if (labels.length > 0) parts.push(`Sẽ bỏ qua: ${labels.join(', ')}`);
  if (unknown.length > 0) parts.push(`Chưa nhận diện: ${unknown.join(', ')} (thử gõ tên tiếng Anh hoặc mã như ja, ko)`);
  hint.innerText = parts.join(' · ');
  hint.classList.toggle('hidden', parts.length === 0);
}

// ---------- Khung giờ chạy ----------
function homeHM(str) {
  const [h, m] = String(str).split(':').map((x) => parseInt(x, 10) || 0);
  return { h, m };
}

// Ghi chú ngắn kèm sau mỗi khung giờ để nhìn là hiểu ngay: cả ngày / vắt qua nửa đêm.
function describeWindowSpan(w) {
  const f = homeHM(w.from);
  const t = homeHM(w.to);
  const fMin = f.h * 60 + f.m;
  const tMin = t.h * 60 + t.m;
  if (fMin === tMin) return ' (cả ngày)';
  if (tMin < fMin) return ' (qua đêm)';
  return '';
}

// 4 ô NHẬP SỐ dạng 24H (thay cho 4 ô select trước đó - gõ trực tiếp nhanh hơn kéo chọn).
// Chỉ cho gõ chữ số, tự cắt còn tối đa 2 ký tự, và tự kẹp về đúng khoảng hợp lệ (giờ
// 0-23, phút 0-59) khi rời khỏi ô (blur) - gõ dở "2" vẫn chưa ép ngay để không phá
// luồng gõ số thứ 2 (vd đang gõ "23" mà ép ngay sau số "2" sẽ hỏng).
function clampHM(raw, max) {
  const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
  if (isNaN(n)) return 0;
  return Math.min(max, Math.max(0, n));
}

function bindHomeWindowNumberInput(id, max, pad = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    el.value = el.value.replace(/[^0-9]/g, '').slice(0, 2);
  });
  el.addEventListener('blur', () => {
    if (el.value === '') return; // để trống thì thôi, không ép về 00 (tránh gõ nhầm mất công xoá)
    const v = String(clampHM(el.value, max));
    el.value = pad ? v.padStart(2, '0') : v; // pad=false: giữ nguyên "9", không ép thành "09"
  });
}

function initHomeWindowInputs() {
  ['homeWindowFromHour', 'homeWindowToHour'].forEach((id) => bindHomeWindowNumberInput(id, 23));
  ['homeWindowFromMin', 'homeWindowToMin'].forEach((id) => bindHomeWindowNumberInput(id, 59));
}

function readHomeWindowInput(prefix) {
  const hEl = document.getElementById(`homeWindow${prefix}Hour`);
  const mEl = document.getElementById(`homeWindow${prefix}Min`);
  if (!hEl || !mEl || hEl.value === '' || mEl.value === '') return '';
  const h = String(clampHM(hEl.value, 23)).padStart(2, '0');
  const m = String(clampHM(mEl.value, 59)).padStart(2, '0');
  hEl.value = h;
  mEl.value = m;
  return `${h}:${m}`;
}

function renderHomeWindows() {
  const list = document.getElementById('homeWindowList');
  if (!list) return;
  list.innerHTML = '';
  if (homeWindows.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'hint-text';
    empty.style.margin = '0';
    empty.innerText = 'Chưa có khung giờ - chạy liên tục.';
    list.appendChild(empty);
    return;
  }
  homeWindows.forEach((w, idx) => {
    const chip = document.createElement('span');
    chip.className = 'tag-item';
    chip.innerHTML = `<span class="tag-name">${escapeHtml(w.from)} → ${escapeHtml(w.to)}${escapeHtml(describeWindowSpan(w))}</span><button type="button" class="tag-rm" title="Xoá">×</button>`;
    chip.querySelector('.tag-rm').addEventListener('click', async () => {
      homeWindows.splice(idx, 1);
      await chrome.storage.local.set({ homeInteractWindows: homeWindows });
      renderHomeWindows();
      showSavedToast();
    });
    list.appendChild(chip);
  });
}

function bindHomeInteractControls() {
  initHomeWindowInputs();
  const btnAdd = document.getElementById('btnAddHomeWindow');
  if (btnAdd) {
    btnAdd.addEventListener('click', async () => {
      const from = readHomeWindowInput('From');
      const to = readHomeWindowInput('To');
      if (!from || !to) return showSavedToast('Hãy chọn đủ giờ bắt đầu và giờ kết thúc');
      // from === to được hiểu là CHẠY CẢ NGÀY (24 giờ) - getHomeWindowState() vốn đã coi
      // giờ kết thúc <= giờ bắt đầu là khung vắt qua ngày hôm sau nên không cần sửa gì thêm.
      if (homeWindows.some((w) => w.from === from && w.to === to)) return showSavedToast('Khung giờ này đã có rồi');
      homeWindows.push({ from, to });
      homeWindows.sort((a, b) => (homeHM(a.from).h * 60 + homeHM(a.from).m) - (homeHM(b.from).h * 60 + homeHM(b.from).m));
      await chrome.storage.local.set({ homeInteractWindows: homeWindows });
      renderHomeWindows();
      showSavedToast('Đã thêm khung giờ');
      // Xoá trắng 4 ô sau khi thêm để gõ khung tiếp theo cho nhanh, không phải tự xoá tay.
      ['homeWindowFromHour', 'homeWindowFromMin', 'homeWindowToHour', 'homeWindowToMin'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
    });
  }
  const langInput = document.getElementById('homeSkipLangInput');
  if (langInput) langInput.addEventListener('input', updateHomeSkipLangHint);
}

// Trạng thái theo khung giờ tại thời điểm `now`: đang trong khung nào (và khung đó kết thúc lúc nào),
// hoặc khung kế tiếp bắt đầu lúc nào. Khung có giờ kết thúc <= giờ bắt đầu được hiểu là QUA NỬA ĐÊM
// (ví dụ 22:00 → 02:00). Xét cả hôm qua/hôm nay/ngày mai để không sót khung vắt qua ngày.
function getHomeWindowState(windows, now = new Date()) {
  const nowMs = now.getTime();
  let endMs = null;
  let nextStartMs = null;
  let nextLabel = '';
  windows.forEach((w) => {
    const f = homeHM(w.from);
    const t = homeHM(w.to);
    const overnight = (t.h * 60 + t.m) <= (f.h * 60 + f.m);
    for (const off of [-1, 0, 1]) {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off, f.h, f.m, 0, 0).getTime();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off + (overnight ? 1 : 0), t.h, t.m, 0, 0).getTime();
      if (nowMs >= start && nowMs < end) endMs = Math.max(endMs === null ? 0 : endMs, end);
      if (start > nowMs && (nextStartMs === null || start < nextStartMs)) {
        nextStartMs = start;
        nextLabel = `${w.from} → ${w.to}`;
      }
    }
  });
  return { inside: endMs !== null, endMs, nextStartMs, nextLabel };
}

function formatClockHM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- Luồng chạy ----------
function readHomeInteractSettings() {
  const maxPosts = Math.max(1, parseInt(document.getElementById('homeInteractMaxInput').value, 10) || 10);
  const delaySec = parseInt(document.getElementById('homeInteractDelayInput').value, 10) || 5;
  const pauseAfter = parseInt(document.getElementById('homeInteractPauseAfterInput').value, 10) || 0;
  const pauseDurationMin = parseFloat(document.getElementById('homeInteractPauseDurationInput').value) || 0;
  const source = getActiveChipValue('homeInteractSource') || 'for_you';
  const langChoice = getActiveChipValue('homeInteractLang') || 'auto';
  const wordMin = document.getElementById('homeInteractWordMin').value.trim();
  const wordMax = document.getElementById('homeInteractWordMax').value.trim();
  const customStyle = document.getElementById('homeInteractCustomStyle').value.trim();
  const likeAfterReply = document.getElementById('homeInteractLikeToggle').checked;
  const skipLangs = resolveSkipLanguages(document.getElementById('homeSkipLangInput').value).codes;

  const lengthInstruction = buildReplyLengthInstruction(wordMin, wordMax);
  const toneValue = getActiveChipValue('homeInteractTone');

  // Mỗi bài trên timeline có 1 ngôn ngữ khác nhau -> prompt phải dựng RIÊNG cho từng bài (trước đây
  // dựng 1 lần duy nhất cho cả lượt chạy nên không thể "theo ngôn ngữ bài đăng" đúng được).
  // Dựng riêng từng bài cũng khiến mỗi reply bốc được 1 góc tiếp cận ngẫu nhiên khác nhau.
  const buildReplyPrompt = (post) => {
    const langInstruction = buildReplyLangInstruction(langChoice, post && post.text, post && post.lang, 'bài đăng');
    return `Bạn là một người dùng X thật, đang lướt timeline và vừa đọc bài đăng dưới đây. Viết reply của bạn cho bài đó.
${langInstruction}

${buildReplyStyleBlock(toneValue, lengthInstruction, customStyle)}

CHỈ TRẢ VỀ ĐÚNG NỘI DUNG REPLY. Không giải thích, không thêm ngoặc kép bao ngoài, không thêm nhãn "Reply:".

${langInstruction}`;
  };

  return { maxPosts, delaySec, pauseAfter, pauseDurationMin, pauseDurationSec: Math.round(pauseDurationMin * 60), source, likeAfterReply, skipLangs, buildReplyPrompt, wordMin, wordMax };
}

async function runHomeInteractFlow() {
  const store = await chrome.storage.local.get(['openaiKey', 'aiModel', 'chip_aiProvider', 'geminiKey', 'deepseekKey']);
  const activeProvider = store.chip_aiProvider || 'openai';
  const hasKey = activeProvider === 'gemini' ? store.geminiKey : activeProvider === 'deepseek' ? store.deepseekKey : store.openaiKey;
  if (!hasKey) return alert(`Nhập API Key cho ${activeProvider.toUpperCase()} trong Cài Đặt!`);

  const cfg = readHomeInteractSettings();
  const unknownLangs = resolveSkipLanguages(document.getElementById('homeSkipLangInput').value).unknown;
  if (unknownLangs.length > 0) logEvent('homeInteract', `Tương tác Home: chưa nhận diện ngôn ngữ "${unknownLangs.join(', ')}" nên chưa lọc theo ngôn ngữ này.`, 'error');

  isHomeInteractRunning = true;
  homeInteractStats = { success: 0, fail: 0 };
  homeInteractTabId = null;
  document.getElementById('btnRunHomeInteract').classList.add('hidden');
  document.getElementById('btnStopHomeInteract').classList.remove('hidden');
  document.getElementById('homeInteractLastError').innerText = '';
  document.getElementById('homeInteractTimer').innerText = '00:00';
  renderHomeInteractProgress(0, cfg.maxPosts);
  logEvent('homeInteract', `Bắt đầu Tương tác Home (${cfg.source === 'following' ? 'Đang theo dõi' : 'Dành cho bạn'}), tối đa ${cfg.maxPosts} bài${homeWindows.length ? ' mỗi khung giờ' : ''} - chỉ reply tài khoản tích xanh`, 'info');

  // run: trạng thái dùng chung giữa các phiên (mỗi khung giờ có thể chia thành nhiều phiên nếu hết bài phải chờ quét lại)
  const run = { skipIds: new Set(), sinceLastPause: 0, consecutiveFails: 0, windowDone: 0, windowKey: null };

  try {
    const history = await getHomeInteractHistory();
    run.skipIds = new Set(Object.keys(history));

    if (homeWindows.length === 0) {
      await runHomeSession(cfg, run, null);
    } else {
      // Có khung giờ: chạy trong khung, hết khung thì ĐỢI khung kế tiếp - tiếp tục cho tới khi bấm DỪNG.
      let announced = null;
      while (isHomeInteractRunning) {
        const st = getHomeWindowState(homeWindows.slice(), new Date());

        if (!st.inside) {
          run.windowKey = null;
          run.windowDone = 0;
          renderHomeInteractProgress(0, cfg.maxPosts);
          if (st.nextStartMs === null) break;
          if (announced !== st.nextStartMs) {
            announced = st.nextStartMs;
            logEvent('homeInteract', `Tương tác Home: chưa tới khung giờ - chờ đến ${formatClockHM(st.nextStartMs)} (${st.nextLabel})`, 'info');
          }
          setHomeInteractStatus(`Chờ Khung Giờ ${st.nextLabel}`);
          await waitClockUntil('homeInteractTimer', st.nextStartMs, () => isHomeInteractRunning);
          continue;
        }

        if (run.windowKey !== st.endMs) {
          run.windowKey = st.endMs;
          run.windowDone = 0;
          run.consecutiveFails = 0;
          renderHomeInteractProgress(0, cfg.maxPosts);
          logEvent('homeInteract', `Tương tác Home: vào khung giờ, chạy đến ${formatClockHM(st.endMs)}`, 'info');
        }

        if (run.windowDone >= cfg.maxPosts) {
          setHomeInteractStatus(`Đã Đủ Số Bài - Chờ Hết Khung Giờ`);
          await waitClockUntil('homeInteractTimer', st.endMs, () => isHomeInteractRunning);
          continue;
        }

        const reason = await runHomeSession(cfg, run, st.endMs);
        if (reason === 'stopped' || reason === 'fatal') break;
        if (reason === 'none' && Date.now() < st.endMs) {
          setHomeInteractStatus('Hết Bài Mới - Chờ Quét Lại');
          await waitClockUntil('homeInteractTimer', Math.min(Date.now() + HOME_NO_POST_RETRY_SEC * 1000, st.endMs), () => isHomeInteractRunning);
        }
      }
    }
  } catch (e) {
    if (isHomeInteractRunning) {
      logEvent('homeInteract', `Lỗi Tương tác Home: ${e.message}`, 'error');
      document.getElementById('homeInteractLastError').innerText = e.message;
      alert(e.message);
    }
  }

  stopHomeInteractFlow();
}

// 1 phiên = mở tab Home -> reply lần lượt các bài -> đóng tab. Kết thúc khi: đủ số bài / hết bài mới /
// hết khung giờ / bấm DỪNG / lỗi 3 bài liên tiếp. Trả về lý do kết thúc.
async function runHomeSession(cfg, run, endAtMs) {
  const alive = () => isHomeInteractRunning && (!endAtMs || Date.now() < endAtMs);
  let reason = 'none';

  const closeTab = () => {
    const tabId = homeInteractTabId;
    homeInteractTabId = null;
    if (tabId) chrome.runtime.sendMessage({ action: 'HOME_INTERACT_CLOSE', tabId }).catch(() => {});
  };

  try {
    while (alive()) {
      if (run.windowDone >= cfg.maxPosts) { reason = 'max'; break; }

      if (!homeInteractTabId) {
        setHomeInteractStatus('Đang mở Home...');
        const opened = await homeInteractMessage({ action: 'HOME_INTERACT_OPEN', source: cfg.source });
        homeInteractTabId = opened.tabId;
        if (!alive()) break;
      }

      setHomeInteractStatus(`${STATUS_RUNNING} - bài ${run.windowDone + 1}/${cfg.maxPosts}`);
      const next = await homeInteractMessage({
        action: 'HOME_INTERACT_NEXT_POST', tabId: homeInteractTabId, source: cfg.source,
        skipIds: Array.from(run.skipIds).slice(-800), skipLangs: cfg.skipLangs,
      });
      if (!alive()) break;
      if (next.recovered) logEvent('homeInteract', 'Trang X đã bị chuyển khỏi Home - đã tự mở lại Home để tiếp tục', 'info');
      if (!next.post) {
        logEvent('homeInteract', 'Không còn bài mới nào trên timeline để reply (đã cuộn hết những bài chưa xử lý).', 'info');
        reason = 'none';
        break;
      }

      const post = next.post;
      run.skipIds.add(post.id); // dù thành công hay lỗi cũng không thử lại bài này trong lượt chạy hiện tại

      try {
        const replyText = await generateReplyWithinWordLimit(cfg.buildReplyPrompt(post), `Bài đăng của @${post.username}:\n${post.text}`, cfg.wordMin, cfg.wordMax, (sys, usr) => callChatAI(sys, usr, undefined, 200));
        if (!replyText) throw new Error('AI trả về nội dung reply rỗng.');
        if (!alive()) break;

        const replyRes = await homeInteractMessage({ action: 'HOME_INTERACT_REPLY', tabId: homeInteractTabId, source: cfg.source, postId: post.id, replyText, likeAfterReply: cfg.likeAfterReply });
        if (replyRes.recovered) logEvent('homeInteract', 'Trang X đã bị chuyển khỏi Home - đã tự mở lại Home', 'info');

        homeInteractStats.success++;
        run.consecutiveFails = 0;
        await markHomeInteracted(post.id);
        document.getElementById('homeInteractLastError').innerText = '';
        logEvent('homeInteract', `Đã reply bài ${run.windowDone + 1}/${cfg.maxPosts} (@${post.username}): ${post.url}`, 'success');
      } catch (innerErr) {
        if (!isHomeInteractRunning) break; // bấm DỪNG giữa chừng: không tính là lỗi
        if (!alive()) break;               // hết khung giờ giữa chừng: không tính là lỗi
        homeInteractStats.fail++;
        run.consecutiveFails++;
        document.getElementById('homeInteractLastError').innerText = `Lỗi bài ${run.windowDone + 1}: ${innerErr.message}`;
        logEvent('homeInteract', `Lỗi bài ${run.windowDone + 1}/${cfg.maxPosts} (@${post.username}): ${innerErr.message}`, 'error');
      }

      run.windowDone++;
      run.sinceLastPause++;
      renderHomeInteractProgress(run.windowDone, cfg.maxPosts);

      if (run.consecutiveFails >= 3) {
        logEvent('homeInteract', 'Dừng Tương tác Home vì lỗi 3 bài liên tiếp - kiểm tra lại thông báo lỗi ở trên.', 'error');
        reason = 'fatal';
        break;
      }
      if (run.windowDone >= cfg.maxPosts) { reason = 'max'; break; }
      if (!alive()) break;

      if (cfg.pauseAfter > 0 && cfg.pauseDurationSec > 0 && run.sinceLastPause >= cfg.pauseAfter) {
        run.sinceLastPause = 0;
        setHomeInteractStatus(`Tạm Nghỉ sau ${cfg.pauseAfter} bài...`);
        logEvent('homeInteract', `Tạm nghỉ ${cfg.pauseDurationMin} phút sau khi hoàn thành ${cfg.pauseAfter} bài`, 'info');
        if (cfg.pauseDurationSec >= 120) closeTab(); // nghỉ dài: đóng tab cho nhẹ máy, hết nghỉ sẽ tự mở lại Home
        await waitClockUntil('homeInteractTimer', Date.now() + cfg.pauseDurationSec * 1000, alive);
      } else {
        await startCountdown(null, 'homeInteractTimer', cfg.delaySec, alive);
      }
    }
  } finally {
    closeTab();
  }

  if (!isHomeInteractRunning) return 'stopped';
  if (endAtMs && Date.now() >= endAtMs) return 'window_end';
  return reason;
}

function stopHomeInteractFlow() {
  isHomeInteractRunning = false;
  document.getElementById('btnRunHomeInteract').classList.remove('hidden');
  document.getElementById('btnStopHomeInteract').classList.add('hidden');
  document.getElementById('homeInteractTimer').innerText = '00:00';
  setHomeInteractStatus(STATUS_IDLE);
  const tabId = homeInteractTabId;
  homeInteractTabId = null;
  chrome.runtime.sendMessage({ action: 'HOME_INTERACT_CLOSE', tabId }).catch(() => {});
}

function waitClockUntil(timerId, targetMs, isRunningFn) {
  return new Promise((resolve) => {
    const timer = document.getElementById(timerId);
    let interval = null;
    const finish = () => {
      clearInterval(interval);
      if (timer) timer.innerText = '00:00';
      resolve();
    };
    const tick = () => {
      if (isRunningFn && !isRunningFn()) return finish();
      const left = Math.ceil((targetMs - Date.now()) / 1000);
      if (left <= 0) return finish();
      if (timer) timer.innerText = formatMMSS(left);
    };
    interval = setInterval(tick, 1000);
    tick();
  });
}

function startCountdown(_unusedBoxId, timerId, seconds, isRunningFn) {
  return waitClockUntil(timerId, Date.now() + seconds * 1000, isRunningFn);
}

const MEDIA_CONFIGS = {
  charLibrary: { fileInput: 'charFileInput', pasteZone: 'charPasteZone', gallery: 'charGallery' },
  mediaLibrary: { fileInput: 'libraryFileInput', pasteZone: 'libraryPasteZone', gallery: 'mediaGallery' }
};

// Logo dự án & Nhân vật/Mascot: CHỌN ĐƯỢC NHIỀU ẢNH cùng lúc (dự án hay có thêm nhân vật
// phụ, hoặc logo ngang + logo vuông) - tất cả ảnh đang chọn đều được gửi kèm cho AI tạo ảnh
// theo đúng thứ tự hiển thị trong thư viện. Bấm vào 1 ảnh = bật/tắt riêng ảnh đó, không
// ảnh hưởng tới các ảnh khác; bỏ chọn hết = không dùng ảnh nào.
// Thư viện ảnh có sẵn (mediaLibrary) KHÔNG đổi: vẫn luôn đúng 1 ảnh đang chọn, vì bài đăng
// chỉ đính kèm được 1 ảnh lấy sẵn.
const MULTI_SELECT_MEDIA_KEYS = ['charLibrary'];
function isMultiSelectMedia(storageKey) {
  return MULTI_SELECT_MEDIA_KEYS.includes(storageKey);
}

// Ảnh đính kèm để AI PHÂN TÍCH khi tạo content ở chế độ "Bằng Text" - khác hẳn với
// Logo/Nhân vật (dùng để AI TẠO ảnh mới dựa theo), ảnh này AI sẽ ĐỌC nội dung trong đó
// (dùng model có khả năng nhìn ảnh - vision) để quyết định nên viết gì + cần tag ai.
// Chỉ 1 ảnh cho mỗi lần tạo (không phải thư viện nhiều ảnh tái sử dụng như Logo/Nhân vật).
let manualAnalysisImageBase64 = null;

function setupManualAnalysisImage() {
  const fileInput = document.getElementById('manualImageFileInput');
  const pasteZone = document.getElementById('manualImagePasteZone');
  const previewBox = document.getElementById('manualImagePreviewBox');
  const previewImg = document.getElementById('manualImagePreviewImg');
  const removeBtn = document.getElementById('btnRemoveManualImage');
  if (!fileInput || !pasteZone) return;

  function setImage(base64) {
    manualAnalysisImageBase64 = base64;
    previewImg.src = base64;
    previewBox.classList.remove('hidden');
    pasteZone.classList.add('hidden');
  }

  function clearImage() {
    manualAnalysisImageBase64 = null;
    previewImg.src = '';
    previewBox.classList.add('hidden');
    pasteZone.classList.remove('hidden');
  }

  function readFileToBase64(file) {
    const reader = new FileReader();
    reader.onload = () => setImage(reader.result);
    reader.readAsDataURL(file);
  }

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) readFileToBase64(file);
    fileInput.value = '';
  });

  const browseLink = pasteZone.querySelector('.paste-zone-browse');
  if (browseLink) {
    browseLink.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
  }

  pasteZone.addEventListener('paste', (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const imageItem = items.find((it) => it.type && it.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) readFileToBase64(file);
    }
  });

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearImage();
  });
}

function setupMediaUploads() {
  Object.entries(MEDIA_CONFIGS).forEach(([storageKey, cfg]) => {
    const fileInput = document.getElementById(cfg.fileInput);
    const pasteZone = document.getElementById(cfg.pasteZone);
    const gallery = document.getElementById(cfg.gallery);

    // Chọn tệp qua hộp thoại
    fileInput.addEventListener('change', (e) => {
      addFilesToGallery(storageKey, Array.from(e.target.files));
      fileInput.value = '';
    });

    // Chỉ liên kết "hoặc chọn tệp" mới mở hộp thoại chọn ảnh - bấm vào phần còn lại
    // của ô chỉ để FOCUS (giống ô nhập chat), sau đó Ctrl+V dán trực tiếp.
    const browseLink = pasteZone.querySelector('.paste-zone-browse');
    if (browseLink) {
      browseLink.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
      });
    }

    // Ctrl+V khi ô đang được focus -> lấy ảnh trực tiếp từ clipboard
    pasteZone.addEventListener('paste', (e) => {
      const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
      const imageFiles = items
        .filter((it) => it.type && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFilesToGallery(storageKey, imageFiles);
      }
    });

    gallery.addEventListener('click', async (e) => {
      // Bấm nút X -> xoá ảnh khỏi thư viện
      const removeBtn = e.target.closest('.thumb-remove');
      if (removeBtn) {
        e.stopPropagation();
        const id = removeBtn.getAttribute('data-id');
        const store = await chrome.storage.local.get([storageKey]);
        let list = store[storageKey] || [];
        const wasSelected = list.some((item) => String(item.id) === id && item.selected);
        list = list.filter((item) => String(item.id) !== id);
        // Chỉ thư viện chọn-1-ảnh mới cần tự chọn bù ảnh khác khi ảnh đang chọn bị xoá.
        // Logo/Nhân vật chọn nhiều ảnh: xoá 1 ảnh thì các ảnh còn lại giữ nguyên lựa chọn.
        if (wasSelected && list.length > 0 && !isMultiSelectMedia(storageKey)) list[0].selected = true;
        await chrome.storage.local.set({ [storageKey]: list });
        renderGallery(storageKey, list);
        logEvent('settings', `Đã xoá 1 ảnh khỏi ${MEDIA_LOG_LABELS[storageKey] || storageKey}.`, 'info');
        return;
      }

      // Bấm vào 1 ảnh trong thư viện để chọn làm ảnh dùng cho AI / đăng bài.
      // - Logo & Nhân vật dự án (MULTI_SELECT_MEDIA_KEYS): bấm = BẬT/TẮT riêng ảnh đó,
      //   chọn được BAO NHIÊU ẢNH TUỲ Ý (nhân vật chính + các nhân vật phụ, nhiều biến
      //   thể logo...). Bỏ chọn hết = không dùng ảnh nào.
      // - Thư viện ảnh có sẵn: giữ nguyên hành vi cũ, luôn đúng 1 ảnh đang chọn.
      const thumb = e.target.closest('.thumb');
      if (!thumb) return;
      const id = thumb.getAttribute('data-id');
      const store = await chrome.storage.local.get([storageKey]);
      const list = store[storageKey] || [];
      const clickedItem = list.find((item) => String(item.id) === id);
      if (!clickedItem) return;
      const wasSelected = !!clickedItem.selected;

      let logMessage;
      if (isMultiSelectMedia(storageKey)) {
        clickedItem.selected = !wasSelected;
        const count = list.filter((item) => item.selected).length;
        const label = MEDIA_LOG_LABELS[storageKey] || storageKey;
        logMessage = count === 0
          ? `Đã bỏ chọn hết ảnh ở mục ${label} (không dùng ảnh nào).`
          : `${wasSelected ? 'Đã bỏ chọn 1 ảnh' : 'Đã chọn thêm 1 ảnh'} ở mục ${label} - đang dùng ${count} ảnh.`;
      } else {
        list.forEach((item) => { item.selected = String(item.id) === id; });
        logMessage = `Đã chọn 1 ảnh làm ảnh đang dùng ở mục ${MEDIA_LOG_LABELS[storageKey] || storageKey}.`;
      }

      await chrome.storage.local.set({ [storageKey]: list });
      renderGallery(storageKey, list);
      logEvent('settings', logMessage, 'info');
    });
  });
}

async function addFilesToGallery(storageKey, files) {
  const store = await chrome.storage.local.get([storageKey]);
  const list = store[storageKey] || [];
  const addedIds = [];
  for (const file of files) {
    const dataUrl = await new Promise((res) => {
      const r = new FileReader();
      r.onload = (e) => res(e.target.result);
      r.readAsDataURL(file);
    });
    const newId = Date.now() + Math.random();
    addedIds.push(newId);
    list.push({ id: newId, dataUrl, selected: false });
  }
  if (isMultiSelectMedia(storageKey)) {
    // Logo/Nhân vật: TẤT CẢ ảnh vừa thêm đều được chọn thêm vào, GIỮ NGUYÊN các ảnh đang
    // chọn từ trước (trước đây thêm ảnh mới sẽ xoá sạch lựa chọn cũ và chỉ giữ lại đúng
    // ảnh cuối cùng - không dán được 1 lượt nhiều nhân vật phụ).
    list.forEach((item) => { if (addedIds.includes(item.id)) item.selected = true; });
  } else {
    // Thư viện ảnh có sẵn: ảnh mới thêm gần nhất tự động được chọn làm ảnh đang dùng
    list.forEach((item) => { item.selected = false; });
    if (list.length > 0) list[list.length - 1].selected = true;
  }
  await chrome.storage.local.set({ [storageKey]: list });
  renderGallery(storageKey, list);
  logEvent('settings', `Đã thêm ${files.length} ảnh vào ${MEDIA_LOG_LABELS[storageKey] || storageKey}.`, 'success');
}

function galleryElementId(storageKey) {
  return MEDIA_CONFIGS[storageKey] ? MEDIA_CONFIGS[storageKey].gallery : 'mediaGallery';
}

function renderGallery(storageKey, list) {
  const gallery = document.getElementById(galleryElementId(storageKey));
  if (!gallery) return;
  gallery.innerHTML = '';
  const multi = isMultiSelectMedia(storageKey);
  let order = 0;
  list.forEach((item) => {
    // Mục chọn-nhiều-ảnh: gắn số thứ tự lên ảnh đang chọn để biết ảnh nào được gửi cho AI
    // và theo thứ tự nào (ảnh số 1 là ảnh chính, các ảnh sau là phụ).
    const badge = multi && item.selected
      ? `<span class="thumb-order">${++order}</span>`
      : '';
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.innerHTML = `<div class="thumb ${item.selected ? 'selected' : ''}" data-id="${item.id}"><img src="${item.dataUrl}"></div>${badge}<button type="button" class="thumb-remove" data-id="${item.id}" title="Xoá ảnh">×</button>`;
    gallery.appendChild(div);
  });
}

// Khôi phục lại ảnh đã lưu khi mở panel (trước đây chỉ hiện được ảnh mới upload
// trong đúng phiên đó, đóng panel ra vào là mất hiển thị dù storage vẫn còn dữ liệu)
async function restoreMediaGalleries() {
  const keys = Object.keys(MEDIA_CONFIGS);
  const store = await chrome.storage.local.get(keys);
  keys.forEach((k) => renderGallery(k, store[k] || []));
}
async function setupRestInteractionSettings() {
  const comment = document.getElementById('restCommentLikePercent');
  const like = document.getElementById('restLikeOnlyPercent');
  const status = document.getElementById('restInteractionStatus');
  const saved = await chrome.storage.local.get('restInteractionCfg');
  comment.value = saved.restInteractionCfg?.commentLikePercent || 0;
  like.value = saved.restInteractionCfg?.likeOnlyPercent || 0;
  const save = async () => {
    const a = Number(comment.value), b = Number(like.value);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 100 || b > 100 || a + b > 100) {
      status.textContent = 'Mỗi tỉ lệ phải từ 0 đến 100, tổng không vượt 100%. Chưa lưu';
      return;
    }
    await chrome.storage.local.set({ restInteractionCfg: { commentLikePercent: a, likeOnlyPercent: b } });
    status.textContent = `Đã lưu: ${a}% comment + like, ${b}% chỉ like, ${100-a-b}% chỉ đọc. Áp dụng từ phiên nghỉ kế tiếp`;
  };
  comment.addEventListener('change', save);
  like.addEventListener('change', save);
}

// BEGIN POST_TEXT_HELPER
// Giữ nguyên URL, email, số thập phân và dấu chấm trong chữ viết tắt.
function cleanPostPunctuation(text) {
  const protectedParts = [];
  let out = String(text || '').replace(/https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d+(?:\.\d+)+\b|\b(?:[A-Za-z]\.){2,}/gi, value => {
    // Dấu chấm cuối URL thường là dấu câu, không thuộc đường dẫn.
    const clean = /^(?:[A-Za-z]\.){2,}$/.test(value) ? value : value.replace(/\.$/, '');
    protectedParts.push(clean);
    return `\uE000${protectedParts.length - 1}\uE001`;
  });
  out = out.replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/(?<!\.)\.(?!\.)(?=[ \t]+|\n|$|[”"’'])/g, '')
    .replace(/\uE000(\d+)\uE001/g, (_, index) => protectedParts[Number(index)]);
  return out.trim();
}

// END POST_TEXT_HELPER
