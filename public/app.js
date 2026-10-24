// 前端逻辑：轮询渲染 + 玩家操作
const $ = (id) => document.getElementById(id);
const COLORS = { p0: '#3ddc97', laok: '#5b8def', tangtang: '#f27ba9', chenshu: '#8a9a5b', mia: '#9b7bd4', azhai: '#e8a33d' };
const colorOf = (id) => {
  const mem = state && state.members ? state.members.find((x) => x.id === id) : null;
  return (mem && mem.color) || COLORS[id] || '#7a8299';
};
const initial = (name) => [...name][0] || '?';

let state = null;
let lastMsgId = 0;
let lastGen = null; // 对局代号：变化 = 换局，清空消息区
let pollTimer = null;
let chosenDiff = 3;
let chosenThink = true;
let chosenTotal = 6;
let chosenMode = 'classic';
let probeTarget = null;
let startOpts = { nickname: '无名氏', difficulty: 3, thinking: true };
let prevPhase = null;
let roomId = localStorage.getItem('wih_room') || null; // 房间ID：刷新/重连不丢局

const phaseLabel = { chat: '闲聊中', vote: '投票', reveal: '本轮结算', end: '结束', lobby: '准备' };

// 模式定义（与 server/modes.js 保持一致）
const MODES = {
  classic: { kind: 'game', label: '经典', tagline: 'AI 伪装人类，揪出所有 AI' },
  reversed: { kind: 'game', label: '反转', tagline: '全员自称 AI，揪出唯一真人' },
  hunt: { kind: 'game', label: '猎杀', tagline: 'AI 联合围猎你，活过 4 轮' },
  flash: { kind: 'game', label: '闪电', tagline: '每轮 6 条封顶，自动开票' },
  hangout: { kind: 'scene', label: '闲聊陪伴', tagline: '一群有血有肉的 AI 群友陪你唠' },
  study: { kind: 'scene', label: '备考复习', tagline: 'AI 考官出题，AI 同学抢答' },
  advisors: { kind: 'scene', label: '智囊参谋', tagline: '一群视角迥异的 AI 顾问团' },
};
const MODE_DESC = {
  classic: 'AI 们伪装成人类。每轮投票放逐，在你不被放逐的前提下找出所有 AI。',
  reversed: '群里每个人都公开声称自己是 AI，但混着 1 个真人类 NPC 也在硬装。谁装得不像？投出去。把 AI 全投完而人类还活着，你输。',
  hunt: '所有 AI 都知道你是唯一人类，要在 4 轮内把你投出去。你有 2 张免死金牌；AI 全票押一人会判串票、随机清退一人。撑满 4 轮即胜。',
  flash: '经典规则 + 极速节奏：每轮 AI 最多 6 条发言，到顶自动进入投票。',
  hangout: '没有投票和胜负。一群性格各异的 AI 群友陪你闲聊，话题自动轮换，随时进随时聊。',
  study: '一位 AI 考官轮流出题点名作答，其他 AI 同学一起答、互相纠错。可在下方输入备考科目。',
  advisors: '抛出你真实的难题（跳槽、装修、创业点子…），每个 AI 从自己的人设视角给意见、互相抬杠。',
};
function endText(mode, winner) {
  if (mode === 'reversed') {
    if (winner === 'human') return { title: '🏆 真人类落网！', desc: '你把藏在群里、硬装 AI 的那个人类揪出来了。<br>这局是人类的胜利，也是你的胜利。' };
    return { title: '💀 猎物逃走了', desc: '唯一的真人类笑到了最后。<br>装 AI 这门手艺，人类还得练。' };
  }
  if (mode === 'hunt') {
    if (winner === 'human') return { title: '🏆 你活下来了！', desc: 'AI 们的围猎宣告失败。<br>4 轮之后，你还在群里。' };
    return { title: '💀 围猎成功', desc: 'AI 们心照不宣地把票投给了你。<br>下次试试带点节奏反打。' };
  }
  if (winner === 'human') return { title: '🏆 你赢了！', desc: '所有伪装成人类的 AI 都被你揪了出来。<br>这场反向图灵测试，人类胜。' };
  return { title: '💀 你被放逐了', desc: '你明明是人类，却被全群当成了 AI 投出去。<br>AI 们的伪装，赢了。' };
}

function avatarHtml(m, size) {
  return `<div class="avatar" style="background:${colorOf(m.id)};width:${size || 34}px;height:${size || 34}px">${initial(m.name)}</div>`;
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

async function api(path, body) {
  let p = path;
  if (roomId && !path.startsWith('/api/start')) {
    p += (p.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(roomId);
  }
  const res = await fetch(p, {
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
  if (s.usage) {
    const g = s.usage.game || {}, ses = s.usage.session || {};
    $('usageChip').textContent = g.cost > 0 ? `💰 本局 $${g.cost.toFixed(4)}` : `💰 本局 ${Math.round((g.totalTokens || 0) / 100) / 10}k tok`;
    $('usageChip').title = `本次运行累计：${ses.calls || 0} 次调用 · ${ses.totalTokens || 0} tokens · $${(ses.cost || 0).toFixed(4)}`;
  }
  if (!inGame) {
    if (s.usage) {
      const ses = s.usage.session || {};
      $('lobbyHint').textContent = `本次运行 API 消耗：${ses.calls || 0} 次调用 · ${ses.totalTokens || 0} tokens · $${(ses.cost || 0).toFixed(4)}（每轮 AI 自动发言上限 16 条）`;
    }
    if (prevPhase !== 'lobby') renderGamesList(); // 只在回到大厅时刷新一次
    prevPhase = 'lobby';
    return;
  }
  prevPhase = s.phase;

  const aliveAIs = s.members.filter((m) => !m.isPlayer && m.alive).length;
  const aliveAll = s.members.filter((m) => m.alive).length;
  const isScene = s.modeKind === 'scene';
  $('aliveInfo').textContent = isScene
    ? `${s.modeLabel} · AI 群友 ${aliveAIs} 位`
    : `存活 ${aliveAll} · 待揪出 AI ${aliveAIs}`;
  $('roundChip').textContent = isScene
    ? (s.phase === 'chat' ? `话题 ${s.round}` : phaseLabel[s.phase] || s.phase)
    : `第 ${s.round} 轮 · ${phaseLabel[s.phase] || s.phase}`;

  renderMembers(s);
  renderMessages(s);
  renderTyping(s);
  renderVotePanel(s);
  renderComposer(s);

  if (s.phase === 'end') {
    const et = endText(s.mode, s.winner);
    $('endTitle').textContent = et.title;
    $('endDesc').innerHTML = et.desc;
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
  if (s.gen !== lastGen) { box.innerHTML = ''; lastMsgId = 0; lastGen = s.gen; } // 换局清屏
  const last = s.messages[s.messages.length - 1];
  if (!last) { box.innerHTML = ''; lastMsgId = 0; return; }
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
  const isScene = s.modeKind === 'scene';
  $('probeBtn').innerHTML = `${isScene ? '提问' : '质询'} <span id="probeCount">×${s.abilities.probe}</span>`;
  $('voteBtn').classList.toggle('hidden', isScene); // 场景模式没有投票
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
  const isScene = state.modeKind === 'scene';
  $('probeTitle').textContent = isScene ? '💬 向群友提问' : '⚡ 突击质询';
  $('probeSub').textContent = isScene
    ? '点名一位群友回答你的问题（闲聊/刷题/求助都能用）。'
    : '点名一位群友立刻回答你的问题。他们只能靠"记忆"作答——答非所问、前后矛盾就是马脚。';
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
  try {
    await api('/api/exit', {});
    localStorage.removeItem('wih_room');
    roomId = null;
  } catch (e) { toast(e.message); }
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
  const gameModes = Object.entries(MODES).filter(([, m]) => m.kind === 'game');
  const sceneModes = Object.entries(MODES).filter(([, m]) => m.kind === 'scene');
  $('modeOptions').innerHTML = gameModes.map(([k, m]) =>
    `<div class="diff-opt ${k === chosenMode ? 'sel' : ''}" data-mode="${k}" title="${m.tagline}">${m.label}</div>`).join('');
  $('sceneOptions').innerHTML = sceneModes.map(([k, m]) =>
    `<div class="diff-opt ${k === chosenMode ? 'sel' : ''}" data-mode="${k}" title="${m.tagline}">${m.label}</div>`).join('');
  $('modeDesc').textContent = MODE_DESC[chosenMode];
  document.querySelectorAll('#modeOptions [data-mode], #sceneOptions [data-mode]').forEach((el) =>
    el.addEventListener('click', () => {
      chosenMode = el.dataset.mode;
      document.querySelectorAll('#modeOptions .sel, #sceneOptions .sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      $('modeDesc').textContent = MODE_DESC[chosenMode];
      $('subjectRow').classList.toggle('hidden', chosenMode !== 'study');
    }));
  const counts = [5, 6, 7, 8, 9];
  $('countOptions').innerHTML = counts.map((n) =>
    `<div class="diff-opt ${n === chosenTotal ? 'sel' : ''}" data-count="${n}">${n}人</div>`).join('');
  $('countOptions').querySelectorAll('[data-count]').forEach((el) =>
    el.addEventListener('click', () => {
      chosenTotal = Number(el.dataset.count);
      $('countOptions').querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    }));
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
    startOpts = {
      nickname: $('nicknameInput').value.trim() || '无名氏', difficulty: chosenDiff,
      thinking: chosenThink, aiCount: chosenTotal - 1, mode: chosenMode,
      subject: ($('subjectInput')?.value || '').trim(),
    };
    try {
      $('startBtn').disabled = true;
      $('startBtn').textContent = '群友入场中…';
      const data = await api('/api/start', startOpts);
      if (data.roomId) {
        roomId = data.roomId;
        localStorage.setItem('wih_room', roomId);
        lastMsgId = 0; // 新房间消息序列从头开始
      }
    } catch (e) { toast(e.message); }
    $('startBtn').disabled = false;
    $('startBtn').textContent = '进入群聊';
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
