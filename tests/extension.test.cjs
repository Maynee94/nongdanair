const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
function loadSection(file, marker, context) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const start = `// BEGIN ${marker}`;
  const end = `// END ${marker}`;
  assert.ok(source.includes(start) && source.includes(end));
  vm.runInContext(source.slice(source.indexOf(start) + start.length, source.indexOf(end)), context);
}
test('lọc dấu câu giữ URL, email, số thập phân, viết tắt và xuống dòng', () => {
  const c = vm.createContext({}); loadSection('background.js', 'POST_TEXT_HELPER', c);
  assert.equal(c.cleanPostPunctuation('Giá 3.14 USD. câu tiếp — có ảnh.\n\nXem https://example.com/a.b và a.b@example.com.\nU.S. tăng!'),
    'Giá 3.14 USD câu tiếp, có ảnh\n\nXem https://example.com/a.b và a.b@example.com\nU.S. tăng!');
});
test('mở tab thường, không đóng cửa sổ chứa tab người dùng', async () => {
  const removed = [], created = [], store = {};
  const c = vm.createContext({ chrome: {
    storage: { session: { get: async key => ({ [key]: store[key] }), set: async data => Object.assign(store, data), remove: async key => delete store[key] } },
    windows: { getAll: async () => [{ id: 7, focused: true }], create: async () => { throw Error('không được tạo popup'); } },
    tabs: { create: async args => { created.push(args); return { id: 42, windowId: args.windowId }; }, remove: async id => removed.push(id) }
  } });
  const s = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  vm.runInContext("const TAB_CTX = { SHARED: 'shared' }; const currentAutomationTabIds = {}; const CTX_WINDOW_KEY = {shared:'automationWindowId'};", c);
  for (const name of ['registerAutomationTab','getStoredWindowId','setStoredWindowId','closeAutomationWindow','openContextWindow']) {
    const start = s.indexOf(`function ${name}(`);
    const begin = s.slice(Math.max(0,start-6),start) === 'async ' ? start-6 : start;
    let i = s.indexOf('{', start), depth = 1, end = i+1;
    for (; depth; end++) { if (s[end] === '{') depth++; if (s[end] === '}') depth--; }
    vm.runInContext(s.slice(begin,end), c);
  }
  await c.openContextWindow('https://x.com'); await c.closeAutomationWindow();
  assert.equal(created[0].windowId, 7); assert.deepEqual(removed, [42]);
});
test('quét URL mở từng bài và đóng đúng tab riêng', async () => {
  const visited = [], removed = []; let listener;
  const c = vm.createContext({ URL, waitMs: async () => {}, startKeepAlive: () => {}, chrome: {
    permissions: { contains: async () => true },
    tabs: { create: async () => ({id:12}), get: async () => ({status:'complete'}), update: async (_, args) => visited.push(args.url), remove: async id => removed.push(id) },
    scripting: { executeScript: async args => [{result: args.args[0] === 'list' ? [{url:'https://example.com/new'}, {url:'https://example.com/older'}] : {text:'Nội dung đầy đủ', images:['https://example.com/image.jpg']}}] },
    runtime: { onMessage: { addListener: fn => listener = fn } }
  }});
  loadSection('background.js', 'URL_SCAN', c);
  const result = await c.scanWebsiteUrl('https://example.com/blog');
  assert.equal(result.articles.length, 2); assert.deepEqual(visited, ['https://example.com/new', 'https://example.com/older']); assert.deepEqual(removed, [12]);
  await assert.rejects(c.scanWebsiteUrl('http://example.com'), /HTTPS/);
});
test('ô URL thuộc Content Crypto và đi vào cấu hình nguồn tin', () => {
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const cryptoStart = html.indexOf('<div id="subtab-crypto"');
  const urlInput = html.indexOf('id="cryptoWebsiteUrls"');
  assert.ok(urlInput > cryptoStart);
  assert.equal(html.includes('id="scanUrlInput"'), false);
  const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  assert.ok(dashboard.includes("['cryptoWebsiteUrls', 'websiteUrls']"));
});
test('nghỉ chuyển tab vừa đăng sang Home, không mở tab mới, Dừng dọn tab', async () => {
  const removed = [], messages = [], logs = [], navigated = [];
  const c = vm.createContext({ Date, cryptoStopRequested: false,
    cryptoNum: (v, def) => v === undefined ? def : v,
    waitUrlScanTab: async () => {},
    waitMs: async () => { c.cryptoStopRequested = true; },
    cryptoLog: async message => logs.push(message),
    cryptoSendToTab: async (id, payload) => { messages.push(payload); return {success:true}; },
    chrome: { tabs: { create: async () => { throw new Error('Không được mở tab mới'); }, update: async (id, args) => navigated.push({id, ...args}), get: async () => ({id:99}),
      sendMessage: async (_, payload) => messages.push(payload), remove: async id => removed.push(id) } }
  });
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function cryptoRestAfterPosting('), source.indexOf('chrome.runtime.onMessage.addListener', source.indexOf('async function cryptoRestAfterPosting('))), c);
  await c.cryptoRestAfterPosting({restMinutes:1}, 99);
  assert.deepEqual(navigated, [{id:99, url:"https://x.com/home", active:true}]);
  assert.equal(messages[0].action, 'HUMAN_BROWSE_HOME_START');
  assert.equal(messages[0].durationMs, 60000);
  assert.equal(messages[1].action, 'HUMAN_BROWSE_HOME_STOP');
  assert.deepEqual(removed, [99]);
  c.cryptoStopRequested = false;
  await c.cryptoRestAfterPosting({restMinutes:0}, 99);
  assert.equal(removed.length, 1);
});
test('hai tỉ lệ là nhóm riêng, phần còn lại chỉ đọc và giới hạn tổng 100%', () => {
  const c = vm.createContext({});
  const source = fs.readFileSync(path.join(root,'content.js'),'utf8');
  const a = source.indexOf('function hbPickInteraction(');
  const b = source.indexOf('async function hbInteractVisiblePost(',a);
  vm.runInContext(source.slice(a,b), c);
  const cfg = {commentLikePercent:20, likeOnlyPercent:30};
  assert.equal(c.hbPickInteraction(cfg,.199), 'commentLike');
  assert.equal(c.hbPickInteraction(cfg,.20), 'likeOnly');
  assert.equal(c.hbPickInteraction(cfg,.499), 'likeOnly');
  assert.equal(c.hbPickInteraction(cfg,.50), 'read');
  assert.equal(c.hbPickInteraction({},0), 'read');
  assert.equal(c.hbPickInteraction({commentLikePercent:100,likeOnlyPercent:100},.99),'commentLike');
});
test('dừng trong lúc AI đang sinh reply thì không gửi comment hoặc like', async () => {
  let sent = 0;
  const token = { stopped:false, deadline:Date.now()+60000, interactionCfg:{commentLikePercent:100}, examined:new Set() };
  const article = {getBoundingClientRect:()=>({top:100})};
  const c = vm.createContext({Date, innerHeight:1000, humanBrowseToken:token,
    hbOnHome:()=>true, getTopLevelArticles:()=>[article], homeReadArticle:()=>({id:'123',username:'other',text:'Tin crypto',hasReplyBtn:true}),
    document:{querySelector:()=>({getAttribute:()=>'/myaccount'})},
    homeReplyToPost:async()=>sent++,
    chrome:{runtime:{sendMessage:async()=>{token.stopped=true;return {success:true,replyText:'Reply'};}}}
  });
  const source=fs.readFileSync(path.join(root,'content.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('function hbPickInteraction(')),c);
  await c.hbInteractVisiblePost(token);
  assert.equal(sent,0); assert.ok(token.examined.has('123'));
});
