// 零依赖 HTTP 服务：静态前端 + 游戏 API
// 启动：node server/index.js （默认 http://localhost:3690）
// 接真实 LLM：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 三个环境变量
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Game } = require('./game');
const { isMock, MODEL, getUsage } = require('./llm');
const { DIFFICULTY_STYLES, generateNPCs } = require('./personas');

const PORT = Number(process.env.PORT || 3690);
const GAMES_DIR = path.join(__dirname, '..', 'games');

// ---------- 多房间管理 ----------
// 每个浏览器会话一个房间（roomId 贯穿所有请求），空闲超时自动回收
const rooms = new Map();
const ROOM_IDLE_MS = Math.max(5, Number(process.env.ROOM_IDLE_MIN || 30)) * 60000;
const randId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function getRoom(id) {
  const g = id && rooms.get(id);
  if (g) g.lastActivity = Date.now();
  return g || null;
}

// 无房间（首次进入/房间已被回收）时的默认大厅视图
function lobbyView() {
  return {
    phase: 'lobby', round: 1, topic: '', difficulty: 3, winner: null, gen: 0,
    mode: 'classic', modeLabel: '经典', modeKind: 'game', roundsTarget: null, goldenTickets: 0,
    abilities: { probe: 0 }, canVote: false, mock: isMock(),
    usage: { session: getUsage(), game: { calls: 0, totalTokens: 0, cost: 0 } },
    members: [], messages: [], voting: null,
  };
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, g] of rooms) {
    if (now - (g.lastActivity || 0) > ROOM_IDLE_MS) {
      g.dispose();
      rooms.delete(id);
      console.log(`[房间回收] ${id} 空闲超过 ${ROOM_IDLE_MS / 60000} 分钟`);
    }
  }
}, 60000);
sweeper.unref();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, data, headers = {}) {
  if (Buffer.isBuffer(data)) {
    res.writeHead(code, headers);
    return res.end(data);
  }
  if (typeof data !== 'string') {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    return res.end(JSON.stringify(data));
  }
  res.writeHead(code, headers);
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- API（room 参数贯穿所有会话级端点） ----
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const g = getRoom(url.searchParams.get('room'));
    return send(res, 200, g ? g.view() : lobbyView());
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    const body = await readBody(req);
    const difficulty = DIFFICULTY_STYLES[body.difficulty] ? Number(body.difficulty) : 3;
    const aiCount = Math.max(3, Math.min(8, Number(body.aiCount) || 5));
    const npcs = await generateNPCs(aiCount); // 真模型现场生成人设（1次调用），mock/失败回退内置池
    const roomId = randId();
    const g = new Game();
    g.lastActivity = Date.now();
    rooms.set(roomId, g);
    g.reset(body.nickname, difficulty, body.thinking !== false, aiCount, npcs, body.mode, body.subject);
    g.start();
    return send(res, 200, { ok: true, roomId, mock: isMock() });
  }
  if (url.pathname === '/api/action' && req.method === 'POST') {
    const g = getRoom(url.searchParams.get('room'));
    if (!g) return send(res, 400, { ok: false, error: '房间不存在或已回收，请重新开局' });
    const body = await readBody(req);
    let out = { ok: false, error: '未知操作' };
    if (body.type === 'say') out = g.playerSay(body.text);
    else if (body.type === 'probe') out = g.playerProbe(body.target, body.question);
    else if (body.type === 'vote') out = g.playerVote(body.target);
    else if (body.type === 'startVote') out = await g.startVote();
    return send(res, out && out.ok === false ? 400 : 200, out);
  }
  // 退出对局：销毁房间（在途 AI 调用作废、定时器清空）
  if (url.pathname === '/api/exit' && req.method === 'POST') {
    const id = url.searchParams.get('room');
    const g = getRoom(id);
    if (g) {
      g.dispose();
      rooms.delete(id);
    }
    return send(res, 200, { ok: true });
  }
  // 历史对局列表
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const list = [];
    try {
      for (const f of fs.readdirSync(GAMES_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), 'utf8'));
          list.push({
            file: f, md: f.replace(/\.json$/, '.md'),
            startedAt: d.startedAt, endedAt: d.endedAt, roundCount: d.roundCount, winner: d.winner,
            nickname: d.members?.find((m) => m.isPlayer)?.name || '?',
            modeLabel: d.modeLabel || '经典', difficultyLabel: d.difficultyLabel, mock: d.mock, thinking: d.thinking,
            cost: d.usage?.cost ?? null, totalTokens: d.usage?.totalTokens ?? null,
          });
        } catch { /* 跳过损坏文件 */ }
      }
    } catch { /* 目录不存在 */ }
    list.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return send(res, 200, list);
  }
  // 删除对局记录：json + md 一起删
  if (url.pathname === '/api/logs' && req.method === 'DELETE') {
    const file = url.searchParams.get('file') || '';
    if (!/^[\w\u4e00-\u9fa5.-]+\.json$/.test(file) || file.includes('..')) {
      return send(res, 400, { ok: false, error: '文件名不合法' });
    }
    const stem = path.basename(file).replace(/\.json$/, '');
    for (const f of [`${stem}.json`, `${stem}.md`]) {
      const p = path.join(GAMES_DIR, f);
      if (path.dirname(p) === GAMES_DIR) fs.rmSync(p, { force: true });
    }
    return send(res, 200, { ok: true });
  }
  // 对局记录文件查看（/games/xxx.md），basename 防目录穿越
  if (url.pathname.startsWith('/games/')) {
    let f;
    try { f = decodeURIComponent(path.basename(url.pathname)); } catch { return send(res, 400, 'bad path'); }
    const p = path.join(GAMES_DIR, f);
    if (!f || !fs.existsSync(p)) return send(res, 404, 'not found');
    const type = f.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8';
    return send(res, 200, fs.readFileSync(p), { 'Content-Type': type });
  }

  // API 消耗汇总：本次运行（内存）+ 历史累计（usage.jsonl）
  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const session = getUsage();
    const allTime = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
    try {
      const lines = fs.readFileSync(path.join(GAMES_DIR, 'usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const j = JSON.parse(l);
          allTime.calls++;
          allTime.promptTokens += j.p || 0;
          allTime.completionTokens += j.c || 0;
          allTime.totalTokens += (j.p || 0) + (j.c || 0);
          allTime.cost += j.cost || 0;
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 无记录文件 */ }
    allTime.cost = +allTime.cost.toFixed(5);
    return send(res, 200, { session, allTime, costSource: 'OpenRouter 返回的 usage.cost，缺失时记 0（仅有 token 计数）' });
  }

  // ---- 静态文件 ----
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(__dirname, '..', 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, '..', 'public'))) return send(res, 403, 'forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  });
});

server.listen(PORT, () => {
  console.log(`Who is Human? 运行在 http://localhost:${PORT}`);
  console.log(isMock()
    ? '⚠ 当前为 MOCK 模式（AI 发言为内置脚本）。设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 即可接入真实模型。'
    : `✓ 已接入模型：${MODEL}`);
});
