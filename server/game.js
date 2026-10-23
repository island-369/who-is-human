// 游戏核心：状态机 + AI 发言调度（时序拟人）+ 投票 + 放逐 + 胜负判定
// 阶段流转：lobby → chat → vote → reveal → chat … → end
const { PERSONAS, topicFor } = require('./personas');
const { buildChatPrompt, buildVotePrompt, buildProbePrompt } = require('./prompts');
const { isMock, chat, chatJSON, mockChat, mockVote, mockProbe } = require('./llm');

const NUM_AI = 5;
const TYPING_BASE = 1200; // 打字耗时基线
const TYPING_PER_CHAR = 55;
const TYPING_MAX = 6000;
const IDLE_GAP = [2600, 6000]; // 群里没人说话时，下一条 AI 消息的间隔
const REPLY_DELAY = [1500, 3800]; // 玩家发言后 AI 接话延迟
const VOTE_REVEAL_STEP = 1000; // 唱票逐条亮票间隔
const CANCEL_CHANCE = 0.08; // "正在输入"后放弃的概率（人类感）
const MIN_AI_MSG_BEFORE_VOTE = 4;

const sleep = (ms_) => new Promise((r) => setTimeout(r, ms_));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const SCALE = Math.max(0.05, Number(process.env.TIMESCALE || 1)); // 测试提速用：TIMESCALE=0.2 全部延迟×0.2
const ms = (x) => Math.round(x * SCALE);

let msgSeq = 1;

class Game {
  constructor() {
    this.timers = new Set();
    this.reset('无名氏', 3);
  }

  reset(nicknameArg = '无名氏', difficulty = 3) {
    this._clearTimers();
    this.phase = 'lobby';
    this.round = 1;
    this.difficulty = difficulty;
    this.winner = null;
    this.evicted = null;
    this.votes = {}; // voterId -> {target, reason}
    this.revealedCount = 0;
    this.voteOrder = [];
    this.waitingPlayer = false; // 唱票停在等玩家投票
    this.abilities = { probe: 2 };
    this.aiMsgThisRound = 0;
    this.accusationDone = false;
    this.tieStreak = 0; // 连续平票轮数（防死锁）
    this.messages = [];
    this.loopGen = 0; // 聊天循环代数，防止双开

    const shuffled = [...PERSONAS].sort(() => Math.random() - 0.5).slice(0, NUM_AI);
    let nickname = (nicknameArg || '无名氏').slice(0, 12);
    while (shuffled.some((p) => p.name === nickname)) nickname += '_'; // 防止与 AI 重名导致投票误伤
    const player = { id: 'p0', name: nickname, isPlayer: true, alive: true, typing: false, revealed: null };
    this.members = [player, ...shuffled.map((p) => ({ id: p.id, name: p.name, isPlayer: false, alive: true, typing: false, revealed: null, persona: p }))];
  }

  _clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  _later(fn, delay) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, delay);
    this.timers.add(t);
    return t;
  }

  get player() { return this.members[0]; }
  aliveMembers() { return this.members.filter((m) => m.alive); }
  aliveAIs() { return this.aliveMembers().filter((m) => !m.isPlayer); }
  byName(name) { return this.members.find((m) => m.name === name); }

  sys(text) {
    this.messages.push({ id: msgSeq++, from: null, name: null, kind: 'system', text, t: Date.now() });
  }

  start() {
    if (this.phase !== 'lobby') return;
    this.phase = 'chat';
    this.sys('游戏开始：「周末搭子群」共 6 人，其中 5 人是伪装成人类的 AI。每轮聊天后全群投票放逐一人，在你不被放逐的前提下找出所有 AI。');
    this.sys(`【第 1 轮话题】${topicFor(1).text}`);
    this._startChatLoop();
  }

  // ---------- 聊天阶段 ----------

  _startChatLoop() {
    const gen = ++this.loopGen;
    const loop = async () => {
      while (this.loopGen === gen && this.phase === 'chat') {
        const speaker = this._pickNextSpeaker();
        if (!speaker) break;
        await this._aiSpeak(speaker);
        if (this.loopGen !== gen || this.phase !== 'chat') break;
        await sleep(ms(rand(...IDLE_GAP)));
      }
    };
    this._later(loop, ms(2000));
  }

  _pickNextSpeaker() {
    const pool = this.aliveAIs();
    if (!pool.length) return null;
    // 偏向最近没发过言的，避免一个人刷屏
    const recent = this.messages.filter((m) => m.kind === 'chat').slice(-6).map((m) => m.from);
    const weights = pool.map((m) => (recent.includes(m.id) ? 1 : 3));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  typingMs(text) {
    return ms(Math.min(TYPING_BASE + text.length * TYPING_PER_CHAR + rand(0, 1200), TYPING_MAX));
  }

  // question 存在时走质询提示词（不含自己的历史发言 → 前后矛盾风险）
  async _aiSpeak(member, instruction, question) {
    member.typing = true;
    let text = null;
    try {
      if (question) {
        const recentOthers = this.messages.filter((m) => m.kind === 'chat' && m.from !== member.id).slice(-8);
        text = isMock()
          ? await mockProbe()
          : await chat([{ role: 'user', content: buildProbePrompt({ persona: member.persona, question, recentOthers, playerName: this.player.name }) }]);
      } else {
        text = isMock()
          ? await mockChat({ persona: member.persona })
          : await chat([{ role: 'user', content: buildChatPrompt({
              persona: member.persona, playerName: this.player.name, topic: topicFor(this.round).text,
              history: this.messages.filter((m) => m.kind === 'chat'), instruction: instruction || this._randomInstruction(),
              difficulty: this.difficulty,
            }) }]);
      }
      if (text) text = text.replace(/^["「『]|["」』]$/g, '').trim().slice(0, 200); // 防长篇大论
    } catch (e) {
      console.error(`[AI发言失败 ${member.name}]`, e.message);
    }
    await sleep(this.typingMs(text || '嗯嗯'));
    member.typing = false;
    if (this.phase !== 'chat' || !text) {
      if (text && this.phase !== 'chat' && Math.random() < 0.3) this.sys(`${member.name} 撤回了一条消息`);
      return; // 阶段变了就闭嘴
    }
    if (!question && Math.random() < CANCEL_CHANCE) { // 时序拟人：偶尔打了又删
      if (Math.random() < 0.3) this.sys(`${member.name} 撤回了一条消息`);
      return;
    }
    this.messages.push({ id: msgSeq++, from: member.id, name: member.name, kind: 'chat', text, t: Date.now() });
    if (!question) this.aiMsgThisRound++;
  }

  _randomInstruction() {
    if (this.aiMsgThisRound === 0) return '聊聊本轮话题，给出你自己的具体经历或观点（一两句即可）。';
    const r = Math.random();
    if (r < 0.12 && !this.accusationDone && this.round >= 2) {
      this.accusationDone = true;
      return '抛出你的怀疑：直接点名（用网名）说你最怀疑谁、哪里不对劲，语气按你的性格来。';
    }
    if (r < 0.5) return '接住最近某人的话头，回应或抬杠他（可在消息里带他的网名）。';
    if (r < 0.8) return '围绕本轮话题补充你自己的具体经历或看法，要具体、带细节。';
    return '自然地跑题聊点符合你人设的日常，不用管话题。';
  }

  playerSay(text) {
    if (this.phase !== 'chat' || !this.player.alive) return { ok: false, error: '现在不能发言' };
    text = (text || '').trim().slice(0, 300);
    if (!text) return { ok: false, error: '消息为空' };
    this.messages.push({ id: msgSeq++, from: 'p0', name: this.player.name, kind: 'chat', text, t: Date.now() });
    // 概率触发 1~2 个 AI 接话
    const responders = this.aliveAIs().sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.2 ? 2 : 1);
    for (const r of responders) {
      if (Math.random() < 0.35) continue; // 不是每句都有人接
      this._later(() => {
        if (this.phase !== 'chat') return;
        this._aiSpeak(r, '刚有群友发了消息，你可以自然接话、抬杠或追问（消息里可以带对方网名）。');
      }, ms(rand(...REPLY_DELAY)));
    }
    return { ok: true };
  }

  // ---------- 玩家质询道具 ----------

  playerProbe(targetId, question) {
    if (this.phase !== 'chat') return { ok: false, error: '只能在聊天阶段质询' };
    if (this.abilities.probe <= 0) return { ok: false, error: '质询次数已用完' };
    const target = this.members.find((m) => m.id === targetId && m.alive && !m.isPlayer);
    question = (question || '').trim().slice(0, 150);
    if (!target || !question) return { ok: false, error: '参数不合法' };
    this.abilities.probe--;
    this.sys(`⚡ ${this.player.name} 发动质询 → ${target.name}：「${question}」`);
    this._later(() => this._aiSpeak(target, null, question), ms(rand(600, 1400)));
    return { ok: true };
  }

  // ---------- 投票阶段 ----------

  canStartVote() {
    return this.phase === 'chat' && this.aiMsgThisRound >= MIN_AI_MSG_BEFORE_VOTE;
  }

  async startVote() {
    if (!this.canStartVote()) return { ok: false, error: '再让大家聊一会儿（需要几条群友发言后才能投票）' };
    this.phase = 'vote';
    this.loopGen++; // 停掉聊天循环
    for (const m of this.members) m.typing = false;
    this.sys(`第 ${this.round} 轮投票开始：投出你觉得最像 AI 的人。`);
    const ais = this.aliveAIs();
    // mock 从众：一半票会跟风同一个目标，模拟真人局选票扎堆
    const herdTarget = isMock() ? pick(this.aliveMembers()).name : null;
    const results = await Promise.all(ais.map(async (ai) => {
      try {
        if (isMock()) {
          const others = this.aliveMembers().filter((m) => m.id !== ai.id).map((m) => m.name);
          const target = herdTarget && others.includes(herdTarget) && Math.random() < 0.5
            ? herdTarget : pick(others);
          const mv = await mockVote({ candidates: [target] });
          return { voter: ai.id, target, reason: mv.reason };
        }
        const out = await chatJSON([{ role: 'user', content: buildVotePrompt({
          persona: ai.persona, playerName: this.player.name,
          aliveMembers: this.aliveMembers().map((m) => ({ id: m.id, name: m.name })),
          history: this.messages.filter((m) => m.kind === 'chat'), topic: topicFor(this.round).text,
        }) }]);
        const t = this.byName(out.target);
        const target = t && t.alive && t.id !== ai.id ? t.name : pick(this.aliveMembers().filter((m) => m.id !== ai.id)).name;
        return { voter: ai.id, target, reason: String(out.reason || '').slice(0, 100) };
      } catch (e) {
        console.error(`[AI投票失败 ${ai.name}]`, e.message);
        return { voter: ai.id, target: pick(this.aliveMembers().filter((m) => m.id !== ai.id)).name, reason: '（沉默地投票）' };
      }
    }));
    for (const r of results) this.votes[r.voter] = { target: r.target, reason: r.reason };
    this.sys('票已收齐，开始唱票……');
    this._stagedReveal();
    return { ok: true };
  }

  _stagedReveal() {
    // 唱票顺序：AI 先亮，玩家压轴
    this.voteOrder = Object.keys(this.votes).filter((id) => id !== 'p0');
    if (this.player.alive) this.voteOrder.push('p0');
    this._revealStep();
  }

  _revealStep() {
    if (this.phase !== 'vote') return;
    const next = this.voteOrder[this.revealedCount];
    if (next === undefined) { this._tally(); return; }
    if (next === 'p0' && !this.votes['p0']) { this.waitingPlayer = true; return; } // 停下等玩家
    this.revealedCount++;
    if (this.voteOrder[this.revealedCount] !== undefined) this._later(() => this._revealStep(), ms(VOTE_REVEAL_STEP));
    else this._later(() => { if (this.phase === 'vote' && this.voteOrder[this.revealedCount] === undefined) this._tally(); }, ms(700));
  }

  playerVote(targetId) {
    if (this.phase !== 'vote') return { ok: false, error: '不在投票阶段' };
    if (this.votes['p0']) return { ok: false, error: '你已经投过了' };
    const target = this.members.find((m) => m.id === targetId && m.alive);
    if (!target) return { ok: false, error: '目标不合法' };
    this.votes['p0'] = { target: target.name, reason: null };
    if (this.waitingPlayer) {
      this.waitingPlayer = false;
      this._later(() => this._revealStep(), ms(800));
    }
    // 其余情况：唱票链会自然走到玩家这一票，或计票定时器已在排队，不做额外触发
    return { ok: true };
  }

  _evict(victim, table, how) {
    victim.alive = false;
    this.evicted = victim.id;
    this.tieStreak = 0;
    if (victim.isPlayer) {
      victim.revealed = 'human';
      this.sys(`唱票结果：${table}。${how}${victim.name} 被放逐——你明明是人类，却被当成了 AI。`);
      this._end('ai');
      return;
    }
    victim.revealed = 'ai';
    this.sys(`唱票结果：${table}。${how}${victim.name} 被放逐——它确实是 AI！`);
  }

  _tally() {
    if (this.phase !== 'vote') return;
    const counts = {};
    for (const v of Object.values(this.votes)) counts[v.target] = (counts[v.target] || 0) + 1;
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const table = entries.map(([name, n]) => `${name} ${n} 票`).join('，');
    const tie = entries.length > 1 && entries[1][1] === entries[0][1];
    if (tie) {
      this.tieStreak++;
      if (this.tieStreak >= 2) {
        // 防死锁：连续平票，在最高票者中抽签放逐
        const tied = entries.filter(([, n]) => n === entries[0][1]).map(([name]) => name);
        const victim = this.byName(pick(tied));
        this._evict(victim, table, '连续平票，抽签决定：');
      } else {
        this.sys(`唱票结果：${table}。平票，本轮无人被放逐。`);
      }
    } else {
      this._evict(this.byName(entries[0][0]), table, '');
    }
    if (this.phase === 'end') return;
    if (this.aliveAIs().length === 0) {
      this.sys('所有 AI 都被找出来了，你赢下了这场反向图灵测试！');
      this._end('human');
      return;
    }
    this.phase = 'reveal';
    this._later(() => this._nextRound(), ms(2200));
  }

  _nextRound() {
    if (this.phase === 'end') return;
    this.round++;
    this.votes = {};
    this.revealedCount = 0;
    this.voteOrder = [];
    this.waitingPlayer = false;
    this.evicted = null;
    this.aiMsgThisRound = 0;
    this.accusationDone = false;
    this.phase = 'chat';
    this.sys(`【第 ${this.round} 轮话题】${topicFor(this.round).text}`);
    this._startChatLoop();
  }

  _end(winner) {
    this.winner = winner;
    this.phase = 'end';
    this.loopGen++;
    this._clearTimers();
    for (const m of this.members) { m.typing = false; m.revealed = m.isPlayer ? 'human' : (m.revealed || 'ai'); }
    this.sys(winner === 'human' ? '🏁 人类胜利！' : '🏁 AI 阵营获胜。');
  }

  // ---------- 给前端的脱敏视图 ----------

  view() {
    const revealAll = this.phase === 'end';
    const voting = this.phase === 'vote' ? {
      total: this.aliveMembers().length,
      revealedCount: this.revealedCount,
      waitingPlayer: this.waitingPlayer,
      order: this.voteOrder.slice(0, this.revealedCount).map((vid) => ({
        voter: this.members.find((m) => m.id === vid)?.name,
        target: this.votes[vid]?.target,
        reason: this.votes[vid]?.reason || null,
      })),
      myVote: this.votes['p0'] ? this.votes['p0'].target : null,
    } : null;
    return {
      phase: this.phase, round: this.round, topic: topicFor(this.round).text,
      difficulty: this.difficulty, winner: this.winner,
      abilities: this.abilities, canVote: this.canStartVote(),
      mock: isMock(),
      members: this.members.map((m) => ({
        id: m.id, name: m.name, alive: m.alive, isPlayer: !!m.isPlayer, typing: m.typing,
        revealed: m.revealed || (revealAll ? (m.isPlayer ? 'human' : 'ai') : null),
      })),
      messages: this.messages.slice(-250),
      voting,
    };
  }
}

module.exports = { Game };
