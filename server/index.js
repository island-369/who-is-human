// 零依赖 HTTP 服务：静态前端 + 游戏 API
// 启动：node server/index.js （默认 http://localhost:3690）
// 接真实 LLM：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 三个环境变量
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Game } = require('./game');
const { isMock, MODEL, getUsage } = require('./llm');
const { DIFFICULTY_STYLES } = require('./personas');

const PORT = Number(process.env.PORT || 3690);
const game = new Game();
const GAMES_DIR = path.join(__dirname, '..', 'games');

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

  // ---- API ----
  if (url.pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, game.view());
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    const body = await readBody(req);
    const difficulty = DIFFICULTY_STYLES[body.difficulty] ? Number(body.difficulty) : 3;
    game.reset(body.nickname, difficulty, body.thinking !== false); // 默认开思考
    game.start();
    return send(res, 200, { ok: true, mock: isMock() });
  }
  if (url.pathname === '/api/action' && req.method === 'POST') {
    const body = await readBody(req);
    let out = { ok: false, error: '未知操作' };
    if (body.type === 'say') out = game.playerSay(body.text);
    else if (body.type === 'probe') out = game.playerProbe(body.target, body.question);
    else if (body.type === 'vote') out = game.playerVote(body.target);
    else if (body.type === 'startVote') out = await game.startVote();
    return send(res, out && out.ok === false ? 400 : 200, out);
  }
  // 退出对局回大厅：reset 会作废所有在途 AI 调用（gameGen 防护）
  if (url.pathname === '/api/exit' && req.method === 'POST') {
    game.reset();
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
            difficultyLabel: d.difficultyLabel, mock: d.mock, thinking: d.thinking,
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
