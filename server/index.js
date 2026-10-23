// 零依赖 HTTP 服务：静态前端 + 游戏 API
// 启动：node server/index.js （默认 http://localhost:3690）
// 接真实 LLM：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 三个环境变量
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Game } = require('./game');
const { isMock, MODEL } = require('./llm');
const { DIFFICULTY_STYLES } = require('./personas');

const PORT = Number(process.env.PORT || 3690);
const game = new Game();

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
    game.reset(body.nickname, difficulty);
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
