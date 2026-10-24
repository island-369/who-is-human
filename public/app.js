// 前端逻辑：轮询渲染 + 玩家操作
const $ = (id) => document.getElementById(id);
const COLORS = { p0: '#3ddc97', laok: '#5b8def', tangtang: '#f27ba9', chenshu: '#8a9a5b', mia: '#9b7bd4', azhai: '#e8a33d' };
const colorOf = (id) => COLORS[id] || '#7a8299';
const initial = (name) => [...name][0] || '?';

let state = null;
let lastMsgId = 0;
let pollTimer = null;
let chosenDiff = 3;
let chosenThink = true;
let probeTarget = null;
let startOpts = { nickname: '无名氏', difficulty: 3, thinking: true };
let prevPhase = null;

const phaseLabel = { chat: '闲聊中', vote: '投票', reveal: '本轮结算', end: '结束', lobby: '准备' };

function avatarHtml(m, size) {
  return `<div class="avatar" style="background:${colorOf(m.id)};width:${size || 34}px;height:${size || 34}px">${initial(m.name)}</div>`;
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------- 渲染 ----------

function render(s) {
  state = s;
  const inGame = s.phase !== 'lobby';
  $('chatHeader').classList.toggle('hidden', !inGame);
  $('membersStrip').classList.toggle('hidden', !inGame);
  $('chatBody').classList.toggle('hidden', !inGame);
  $('lobby').classList.toggle('hidden', inGame);
  $('mockBadge').classList.toggle('hidden', !s.mock);
  if (!inGame) {
    if (prevPhase !== 'lobby') renderGamesList(); // 只在回到大厅时刷新一次
    prevPhase = 'lobby';
    return;
  }
  prevPhase = s.phase;

  const aliveAIs = s.members.filter((m) => !m.isPlayer && m.alive).length;
  const aliveAll = s.members.filter((m) => m.alive).length;
  $('aliveInfo').textContent = `存活 ${aliveAll} · 待揪出 AI ${aliveAIs}`;
  $('roundChip').textContent = `第 ${s.round} 轮 · ${phaseLabel[s.phase] || s.phase}`;

  renderMembers(s);
  renderMessages(s);
  renderTyping(s);
  renderVotePanel(s);
  renderComposer(s);

  if (s.phase === 'end') {
    $('endTitle').textContent = s.winner === 'human' ? '🏆 你赢了！' : '💀 你被放逐了';
    $('endDesc').innerHTML = s.winner === 'human'
      ? '所有伪装成人类的 AI 都被你揪了出来。<br>这场反向图灵测试，人类胜。'
      : '你明明是人类，却被全群当成了 AI 投出去。<br>AI 们的伪装，赢了。';
    $('endIdentities').innerHTML = s.members.map((m) => `
      <div class="identity-card ${m.revealed === 'ai' ? 'is-ai' : 'is-human'}">
        ${avatarHtml(m, 26)} ${esc(m.name)} ${m.isPlayer ? '（你·人类）' : m.revealed === 'ai' ? '🤖 AI' : '👤'}
      </div>`).join('');
    $('endOverlay').classList.remove('hidden');
  } else {
    $('endOverlay').classList.add('hidden');
  }
}

function renderMembers(s) {
  $('membersStrip').innerHTML = s.members.map((m) => {
    const tag = m.revealed ? `<span class="tag ${m.revealed}">${m.revealed === 'ai' ? 'AI' : '人类'}</span>` : '';
    return `<div class="member-pill ${m.alive ? '' : 'dead'}">
      ${avatarHtml(m, 38)}${tag}<span class="mname">${esc(m.name)}${m.isPlayer ? '(你)' : ''}</span></div>`;
  }).join('');
}

function renderMessages(s) {
  const box = $('messages');
  const last = s.messages[s.messages.length - 1];
  if (!last) { box.innerHTML = ''; lastMsgId = 0; return; }
  if (last.id < lastMsgId) { box.innerHTML = ''; lastMsgId = 0; } // id 回退 = 新开局，重置
  for (const m of s.messages) {
    if (m.id <= lastMsgId) continue;
    lastMsgId = m.id;
    if (m.kind === 'system') {
      const el = document.createElement('div');
      el.className = 'sysmsg' + (/投票|唱票|放逐|质询|游戏|⚡|🏁/.test(m.text) ? ' important' : '');
      el.textContent = m.text;
      box.appendChild(el);
    } else {
      const mine = m.from === 'p0';
      const el = document.createElement('div');
      el.className = 'msg-row' + (mine ? ' mine' : '');
      el.innerHTML = `
        ${avatarHtml({ id: m.from, name: m.name })}
        <div class="msg-col"><div class="msg-meta">${esc(m.name)}</div><div class="bubble">${esc(m.text)}</div></div>`;
      box.appendChild(el);
    }
    box.scrollTop = box.scrollHeight;
  }
}

function renderTyping(s) {
  const typers = s.members.filter((m) => m.typing && m.alive);
  const row = $('typingRow');
  if (!typers.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  row.innerHTML = typers.map((m) => avatarHtml(m, 16)).join('') +
    `<span class="dots">${typers.map((m) => esc(m.name)).join('、')} 正在输入</span>`;
}

function renderVotePanel(s) {
  const p = $('votePanel');
  if (s.phase !== 'vote' && s.phase !== 'reveal') { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  const v = s.voting || { order: [], revealedCount: 0 };
  let html = `<div class="vote-head">🗳 第 ${s.round} 轮投票</div>`;

  if (s.phase === 'reveal') {
    html += `<div class="vote-sub">本轮投票结束，即将进入下一轮……</div>`;
  } else if (!v.myVote) {
    html += `<div class="vote-sub">点击放逐你觉得最像 AI 的人（也可先观察大家的唱票理由）</div><div class="vote-candidates">`;
    for (const m of s.members.filter((x) => x.alive && !x.isPlayer)) {
      html += `<div class="vote-cand" data-vote="${m.id}">${avatarHtml(m, 28)} ${esc(m.name)}</div>`;
    }
    html += `</div>`;
  }
  if (v.order.length || v.myVote) {
    html += `<div class="vote-tally">`;
    for (const r of v.order) {
      html += `<div class="tally-item"><span class="who">${esc(r.voter)}</span>
        <span>→ <b>${esc(r.target)}</b></span>${r.reason ? `<span class="reason">“${esc(r.reason)}”</span>` : ''}</div>`;
    }
    html += `</div>`;
    if (s.phase === 'vote' && v.revealedCount < v.total) {
      html += `<div class="vote-sub">${v.waitingPlayer ? '' : '唱票中…'}</div>`;
    }
  }
  if (v.waitingPlayer && s.phase === 'vote' && !v.myVote) {
    html += `<div class="waiting-me">🔔 轮到你投票了！全群都在等你</div>`;
  }
  p.innerHTML = html;
  p.querySelectorAll('[data-vote]').forEach((el) =>
    el.addEventListener('click', () => doVote(el.dataset.vote)));
}

function renderComposer(s) {
  const c = $('composer');
  if (s.phase !== 'chat') { c.classList.add('hidden'); return; }
  c.classList.remove('hidden');
  $('probeCount').textContent = `×${s.abilities.probe}`;
  $('probeBtn').disabled = s.abilities.probe <= 0;
  $('voteBtn').disabled = !s.canVote;
  $('voteBtn').classList.toggle('ready', s.canVote);
  $('voteBtn').textContent = s.canVote ? '发起投票' : '票未解锁';
  $('msgInput').disabled = false;
}

// ---------- 操作 ----------

async function doSay() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text) return;
  try {
    input.value = '';
    input.focus();
    await api('/api/action', { type: 'say', text });
  } catch (e) { toast(e.message); }
}

async function doVote(target) {
  try { await api('/api/action', { type: 'vote', target }); }
  catch (e) { toast(e.message); }
}

function openProbeModal() {
  if (!state || state.phase !== 'chat' || state.abilities.probe <= 0) return;
  probeTarget = null;
  $('probeQuestion').value = '';
  $('probeTargets').innerHTML = state.members
    .filter((m) => m.alive && !m.isPlayer)
    .map((m) => `<div class="probe-target" data-probe="${m.id}">${avatarHtml(m, 22)} ${esc(m.name)}</div>`)
    .join('');
  $('probeTargets').querySelectorAll('[data-probe]').forEach((el) =>
    el.addEventListener('click', () => {
      probeTarget = el.dataset.probe;
      $('probeTargets').querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    }));
  $('probeModal').classList.remove('hidden');
}

async function doProbe() {
  if (!probeTarget) { toast('先选一个质询对象'); return; }
  const q = $('probeQuestion').value.trim();
  if (!q) { toast('输入你要质询的问题'); return; }
  try {
    await api('/api/action', { type: 'probe', target: probeTarget, question: q });
    $('probeModal').classList.add('hidden');
  } catch (e) { toast(e.message); }
}

// ---------- 退出对局 / 历史对局 ----------

async function doExit() {
  const btn = $('exitBtn');
  if (!btn.dataset.armed) { // 两段确认，防误触
    btn.dataset.armed = '1';
    btn.textContent = '确认退出';
    btn.classList.add('armed');
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = '退出'; btn.classList.remove('armed'); }, 3000);
    return;
  }
  delete btn.dataset.armed;
  btn.textContent = '退出';
  btn.classList.remove('armed');
  try { await api('/api/exit', {}); } catch (e) { toast(e.message); }
}

async function renderGamesList() {
  const el = $('gamesList');
  try {
    const list = await api('/api/logs');
    if (!list.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<h3>历史对局</h3>' + list.map((g) => {
      const res = g.winner === 'human' ? '🏆人类胜' : g.winner === 'ai' ? '💀AI胜' : '未完成';
      const when = (g.startedAt || '').slice(5, 16).replace('T', ' ');
      return `<div class="games-item" data-file="${esc(g.file)}">
        <span class="gi-info">${esc(when)} · ${esc(g.nickname)} · ${g.roundCount}轮 · ${res}${g.mock ? ' · MOCK' : ''}${g.thinking ? ' · 思考' : ''}</span>
        <a class="gi-view" href="/games/${encodeURIComponent(g.md)}" target="_blank">查看</a>
        <button class="gi-del">删除</button></div>`;
    }).join('');
    el.querySelectorAll('.gi-del').forEach((btn) => btn.addEventListener('click', async () => {
      const file = btn.closest('.games-item').dataset.file;
      try {
        await fetch(`/api/logs?file=${encodeURIComponent(file)}`, { method: 'DELETE' });
        renderGamesList();
      } catch { toast('删除失败'); }
    }));
  } catch { /* 服务未就绪等，忽略 */ }
}

// ---------- 大厅 ----------

function initLobby() {
  const diffs = [[1, '简单'], [3, '普通'], [5, '困难']];
  $('diffOptions').innerHTML = diffs.map(([v, label]) =>
    `<div class="diff-opt ${v === chosenDiff ? 'sel' : ''}" data-diff="${v}">${label}</div>`).join('');
  $('diffOptions').querySelectorAll('[data-diff]').forEach((el) =>
    el.addEventListener('click', () => {
      chosenDiff = Number(el.dataset.diff);
      $('diffOptions').querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    }));
  const thinks = [[true, '开'], [false, '关']];
  $('thinkOptions').innerHTML = thinks.map(([v, label]) =>
    `<div class="diff-opt ${v === chosenThink ? 'sel' : ''}" data-think="${v}">${label}</div>`).join('');
  $('thinkOptions').querySelectorAll('[data-think]').forEach((el) =>
    el.addEventListener('click', () => {
      chosenThink = el.dataset.think === 'true';
      $('thinkOptions').querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    }));
  $('startBtn').addEventListener('click', async () => {
    startOpts = { nickname: $('nicknameInput').value.trim() || '无名氏', difficulty: chosenDiff, thinking: chosenThink };
    try { await api('/api/start', startOpts); }
    catch (e) { toast(e.message); }
  });
  $('againBtn').addEventListener('click', async () => {
    $('endOverlay').classList.add('hidden');
    try { await api('/api/start', startOpts); }
    catch (e) { toast(e.message); }
  });
}

// ---------- 启动 ----------

function bind() {
  $('sendBtn').addEventListener('click', doSay);
  $('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSay(); });
  $('voteBtn').addEventListener('click', async () => {
    try { await api('/api/action', { type: 'startVote' }); } catch (e) { toast(e.message); }
  });
  $('probeBtn').addEventListener('click', openProbeModal);
  $('probeCancel').addEventListener('click', () => $('probeModal').classList.add('hidden'));
  $('probeGo').addEventListener('click', doProbe);
  $('exitBtn').addEventListener('click', doExit);
}

async function poll() {
  try {
    const s = await api('/api/state');
    render(s);
  } catch (e) { /* 服务重启等情况，下轮重试 */ }
}

initLobby();
bind();
poll();
pollTimer = setInterval(poll, 800);
