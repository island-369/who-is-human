// 游戏核心：状态机 + AI 发言调度（时序拟人）+ 投票 + 放逐 + 胜负判定
// 阶段流转：lobby → chat → vote → reveal → chat … → end
const fs = require('node:fs');
const path = require('node:path');
const { DIFFICULTY_STYLES, topicFor, casualTopicFor, PALETTE, buildStockNPCs } = require('./personas');
const { MODES } = require('./modes');
const { buildChatPrompt, buildVotePrompt, buildProbePrompt } = require('./prompts');
const { isMock, chat, chatJSON, mockChat, mockVote, mockProbe, MODEL, getUsage } = require('./llm');

const GAMES_DIR = path.join(__dirname, '..', 'games');

const AI_MSG_CAP = Number(process.env.AI_MSG_CAP || 16); // 每轮 AI 自动发言上限：防止挂机烧钱
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

// 对局快照 → 可读 markdown（复盘伪装效果用）
function roundLogsToMarkdown(r) {
  const L = [];
  L.push('# Who is Human? 对局记录', '');
  L.push(`- 开局：${r.startedAt}${r.endedAt ? ` ｜ 终局：${r.endedAt}` : '（进行中）'}`);
  L.push(`- 配置：模式 ${r.modeLabel || '经典'} ｜ 难度 ${r.difficultyLabel}${r.thinking ? ' ｜ 深度思考开' : ''}${r.mock ? ' ｜ MOCK 模式' : ` ｜ 模型 ${r.model}`}`);
  const outcome = r.winner === 'human' ? '🏆 人类胜利' : r.winner === 'ai' ? '💀 AI 胜利（玩家被放逐）' : '进行中';
  L.push(`- 结果：${outcome}，共 ${r.roundCount} 轮`);
  L.push(`- 成员：${r.members.map((m) => `${m.name}${m.isPlayer ? '（你）' : ''}=${m.revealed === 'ai' ? 'AI' : m.revealed === 'human' ? '人类' : '?'}${m.alive ? '' : '（出局）'}`).join('，')}`);
  for (const rd of r.rounds) {
    L.push('', `## 第 ${rd.round} 轮`, '', `**话题**：${rd.topic}`, '', '### 聊天', '');
    for (const m of rd.messages) L.push(m.kind === 'system' ? `> ${m.text}` : `**${m.name}**：${m.text}`);
    L.push('', '### 投票', '');
    for (const v of rd.votes) L.push(`- ${v.voter} → **${v.target}**${v.reason ? `（${v.reason}）` : ''}`);
    if (rd.result) L.push('', `**结果**：${rd.result}`);
  }
  return L.join('\n') + '\n';
}

class Game {
  constructor() {
    this.timers = new Set();
    this.reset('无名氏', 3);
  }

  reset(nicknameArg = '无名氏', difficulty = 3, thinking = true, aiCount = 5, npcs = null, mode = 'classic', subject = '') {
    this._clearTimers();
    this.phase = 'lobby';
    this.round = 1;
    this.difficulty = difficulty;
    this.thinking = !!thinking; // AI 深度思考：开=发言更慢更像人，投票理由更扎实
    this.mode = MODES[mode] ? mode : 'classic';
    this.modeKind = MODES[this.mode]?.kind || 'game';
    this.subject = String(subject || '').trim().slice(0, 20); // 备考复习的科目
    this.humanNpcId = null; // 反转场：藏匿的真人类 NPC 的成员 id
    this.winner = null;
    this.evicted = null;
    this.votes = {}; // voterId -> {target, reason}
    this.revealedCount = 0;
    this.voteOrder = [];
    this.waitingPlayer = false; // 唱票停在等玩家投票
    this.abilities = { probe: this.modeKind === 'scene' ? 5 : 2 }; // 场景模式=自由提问，游戏模式=2次质询
    this.goldenTickets = this.mode === 'hunt' ? 2 : 0; // 猎杀场免死金牌
    this.examinerId = null; // 备考复习的 AI 考官
    this.aiMsgThisRound = 0;
    this.accusationDone = false;
    this.tieStreak = 0; // 连续平票轮数（防死锁）
    this.messages = [];
    this.loopGen = 0; // 聊天循环代数，防止双开
    this.gameGen = (this.gameGen || 0) + 1; // 对局代号：reset 后作废所有跨局的在途调用
    this.roundLogs = [];
    this._roundStartIdx = 0;
    this.capHintShown = false;
    this.usageAtStart = getUsage(); // 本局消耗基线

    // 对局留档：固定文件名（开局时间+昵称），每轮结算时覆盖写入
    const d = new Date();
    this.startedAt = d;
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const safeNick = (nicknameArg || '无名氏').replace(/[\\/:*?"<>|\s]/g, '').slice(0, 12) || '无名氏';
    this.logBase = path.join(GAMES_DIR, `${stamp}-${safeNick}`);

    this.aiCount = Math.max(3, Math.min(8, Number(aiCount) || 5));
    const chosen = (Array.isArray(npcs) && npcs.length >= this.aiCount ? npcs : buildStockNPCs(this.aiCount)).slice(0, this.aiCount);
    let nickname = (nicknameArg || '无名氏').slice(0, 12);
    while (chosen.some((p) => p.name === nickname)) nickname += '_'; // 防止与 AI 重名导致投票误伤
    const player = { id: 'p0', name: nickname, color: '#3ddc97', isPlayer: true, alive: true, typing: false, revealed: null };
    this.members = [player, ...chosen.map((p, i) => ({
      id: `npc${i}`, name: p.name, color: PALETTE[(i + 1) % PALETTE.length],
      isPlayer: false, alive: true, typing: false, revealed: null,
      persona: { id: `npc${i}`, name: p.name, sheet: p.sheet },
    }))];
    if (this.mode === 'reversed') {
      const npc = pick(this.members.filter((m) => !m.isPlayer));
      npc.humanNPC = true; // 唯一真人类（伪装成AI）
      this.humanNpcId = npc.id;
    }
    if (this.mode === 'study' && this.members.length > 1) {
      this.examinerId = this.members[1].id; // 第一位 AI 当考官
    }
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

  // 当前轮的"话题"文案（场景模式各有各的含义）
  currentTopicText() {
    if (this.mode === 'hangout') return casualTopicFor(this.round);
    if (this.mode === 'study') return this.subject ? `科目「${this.subject}」练习时间：考官出题，群友作答` : '自习时间：考官出题，群友作答';
    if (this.mode === 'advisors') return '（没有固定话题——把你真实的难题丢进群里，顾问们各自接招）';
    return topicFor(this.round).text;
  }

  start() {
    if (this.phase !== 'lobby') return;
    this.phase = 'chat';
    const n = this.members.length;
    const announce = {
      classic: `游戏开始：「周末搭子群」共 ${n} 人，其中 ${this.aiCount} 人是伪装成人类的 AI。每轮聊天后全群投票放逐一人，在你不被放逐的前提下找出所有 AI。`,
      reversed: `反转场开始：群里 ${n} 个人人都公开声称自己是 AI——但其中混着 1 个真人类！谁装 AI 装得不像？把他投出去你就赢；把 AI 全投完而人类还活着，你输。`,
      hunt: `猎杀场开始：所有 AI 都收到了情报，知道你是唯一的人类，它们要在 ${MODES.hunt.roundsTarget} 轮内把你投出去。你有 ${this.goldenTickets} 张免死金牌（被最高票命中时自动流局）；AI 全票押一人会判串票、随机清退一人。撑满 ${MODES.hunt.roundsTarget} 轮即胜。`,
      flash: `闪电场开始：节奏拉满——每轮 AI 最多 ${MODES.flash.msgCap} 条发言，到顶自动进入投票。规则同经典：揪出所有 AI，别被投出去。`,
      hangout: `欢迎进群！这里没有投票没有胜负，${n - 1} 位性格各异的 AI 群友陪你唠嗑，话题会自动换，你想聊什么直接说。`,
      study: `自习室开张！${this.members.find((m) => m.id === this.examinerId)?.name || '考官'} 担任考官${this.subject ? `，科目：${this.subject}` : ''}。考官出题点名作答，AI 同学们会抢答和互相纠错——你也在群里，一起答。`,
      advisors: `顾问团已就位：${n - 1} 位背景迥异的 AI 顾问。把你的真实难题丢进来（尽量给足背景信息），他们会各自给意见、互相抬杠。你负责追问和拍板。`,
    };
    this.sys(announce[this.mode]);
    if (this.modeKind === 'game' || this.mode === 'hangout' || this.mode === 'study') {
      this.sys(`【第 1 轮话题】${this.currentTopicText()}`);
    }
    this._roundStartIdx = this.messages.length;
    this._startChatLoop();
  }

  // ---------- 聊天阶段 ----------

  _startChatLoop() {
    const gen = ++this.loopGen;
    const loop = async () => {
      while (this.loopGen === gen && this.phase === 'chat') {
        const rotate = MODES[this.mode]?.rotateEvery;
        if (this.modeKind === 'scene' && rotate && this.aiMsgThisRound >= rotate) {
          // 场景模式：到量自动换话题，继续聊（不退出循环）
          this.round++;
          this.aiMsgThisRound = 0;
          this.accusationDone = false;
          this.sys(`【新话题】${this.currentTopicText()}`);
          this._roundStartIdx = this.messages.length;
          await sleep(ms(rand(...IDLE_GAP)));
          continue;
        }
        const cap = MODES[this.mode]?.msgCap || AI_MSG_CAP;
        if (this.aiMsgThisRound >= cap) { // 轮内封顶：AI 停止自动互聊
          if (MODES[this.mode]?.autoVote) { await this.startVote(); break; } // 闪电场：到顶自动开票
          if (!this.capHintShown) {
            this.capHintShown = true;
            this.sys('（群里安静下来了——本轮 AI 发言已达上限。你可以继续发言引他们接话，或直接发起投票。）');
          }
          break;
        }
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
    const gen = this.gameGen; // 在途调用标记：期间 reset 的话结果作废
    this._currentMemberId = member.id; // 供场景指令判断（考官等）
    member.typing = true;
    let text = null;
    try {
      if (question) {
        const recentOthers = this.messages.filter((m) => m.kind === 'chat' && m.from !== member.id).slice(-8);
        text = isMock()
          ? await mockProbe()
          : await chat([{ role: 'user', content: buildProbePrompt({ persona: member.persona, question, recentOthers, playerName: this.player.name, mode: this.mode, isHumanNPC: !!member.humanNPC }) }], { thinking: this.thinking });
      } else {
        text = isMock()
          ? await mockChat({ persona: member.persona })
          : await chat([{ role: 'user', content: buildChatPrompt({
              persona: member.persona, playerName: this.player.name, topic: this.currentTopicText(),
              history: this.messages.filter((m) => m.kind === 'chat'), instruction: instruction || this._randomInstruction(),
              difficulty: this.difficulty, mode: this.mode, isHumanNPC: !!member.humanNPC,
            }) }], { thinking: this.thinking });
      }
      if (text) text = text.replace(/^["「『]|["」』]$/g, '').trim().slice(0, 200); // 防长篇大论
    } catch (e) {
      console.error(`[AI发言失败 ${member.name}]`, e.message);
    }
    await sleep(this.typingMs(text || '嗯嗯'));
    member.typing = false;
    if (gen !== this.gameGen) return; // 对局已重置，这条消息不属于本局
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
    // 场景模式有自己的指令体系
    if (this.modeKind === 'scene') return this._sceneInstruction();
    if (this.aiMsgThisRound === 0) {
      if (this.mode === 'reversed') return '聊聊本轮话题，并在发言里顺带宣告你是AI（用你的角色风格说，比如"本人AI，只对数据类话题有反应"这种搞笑宣言也行）。';
      return '聊聊本轮话题，给出你自己的具体经历或观点（一两句即可）。';
    }
    const r = Math.random();
    if (r < 0.12 && !this.accusationDone && this.round >= 2) {
      this.accusationDone = true;
      return '抛出你的怀疑：直接点名（用网名）说你最怀疑谁、哪里不对劲，语气按你的性格来。';
    }
    if (r < 0.5) return '接住最近某人的话头，回应或抬杠他（可在消息里带他的网名）。';
    if (r < 0.8) return '围绕本轮话题补充你自己的具体经历或看法，要具体、带细节。';
    return '自然地跑题聊点符合你人设的日常，不用管话题。';
  }

  // 场景模式（闲聊/备考/参谋）的发言指令
  _sceneInstruction() {
    const recent = this.messages.filter((m) => m.kind === 'chat');
    const lastPlayer = [...recent].reverse().find((m) => m.from === 'p0');
    const isExaminer = this.examinerId && this.examinerId === this._currentMemberId;

    if (this.mode === 'study') {
      if (isExaminer) {
        if (!recent.some((m) => m.kind === 'chat')) {
          return `你是本群考官${this.subject ? `（科目：${this.subject}）` : ''}。出一道有质量的练习题（可以带选项），并点名一位群友作答。`;
        }
        return `你是考官。点评群友们的上一份答案（谁对谁错、错在哪），然后出一道新题点名下一位作答。`;
      }
      if (!recent.some((m) => m.kind === 'chat')) return '你是学员，简短打个招呼表示准备好了。';
      return '考官刚出了题：给出你的答案和简单解题思路（按你人设的水平来，可以答错，也会有人纠错）。';
    }

    if (this.mode === 'advisors') {
      if (!lastPlayer) return '开场：用一两句话亮出你的身份和擅长领域，表示随时可以接问题。';
      return `玩家抛出了难题：「${(lastPlayer.text || '').slice(0, 80)}」。从你的人设视角给出具体、可执行的建议或反对意见（一两句），可以反驳其他顾问刚才的说法。`;
    }

    // hangout
    if (!recent.some((m) => m.kind === 'chat')) return '聊聊本轮话题，给出你自己的具体经历（一两句即可）。';
    const r = Math.random();
    if (r < 0.5) return '接住最近某人的话头，回应或追问（可带对方网名）。';
    if (r < 0.8) return '围绕本轮话题补充你的具体经历或看法，要具体、带细节。';
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
    return this.modeKind === 'game' && this.phase === 'chat' && this.aiMsgThisRound >= MIN_AI_MSG_BEFORE_VOTE;
  }

  async startVote() {
    if (!this.canStartVote()) return { ok: false, error: '再让大家聊一会儿（需要几条群友发言后才能投票）' };
    this.phase = 'vote';
    this.loopGen++; // 停掉聊天循环
    const gen = this.gameGen; // 收票期间若 reset，弃票
    for (const m of this.members) m.typing = false;
    const voteAsk = this.mode === 'reversed' ? '投出你怀疑的"真人装AI"'
      : this.mode === 'hunt' ? '投出你最怀疑的人'
      : '投出你觉得最像 AI 的人';
    this.sys(`第 ${this.round} 轮投票开始：${voteAsk}。`);
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
          mode: this.mode, isHumanNPC: !!ai.humanNPC,
        }) }], { thinking: this.thinking });
        const t = this.byName(out.target);
        const target = t && t.alive && t.id !== ai.id ? t.name : pick(this.aliveMembers().filter((m) => m.id !== ai.id)).name;
        return { voter: ai.id, target, reason: String(out.reason || '').slice(0, 100) };
      } catch (e) {
        console.error(`[AI投票失败 ${ai.name}]`, e.message);
        return { voter: ai.id, target: pick(this.aliveMembers().filter((m) => m.id !== ai.id)).name, reason: '（沉默地投票）' };
      }
    }));
    for (const r of results) this.votes[r.voter] = { target: r.target, reason: r.reason };
    if (gen !== this.gameGen) return { ok: false, error: '对局已重置' }; // 票已作废
    // 猎杀场串票惩罚：AI 全票押一人 → 判串票，随机清退一个 AI（逼它们分散投票，给玩家活路）
    if (this.mode === 'hunt' && results.length >= 3) {
      const targets = new Set(results.map((r) => r.target));
      if (targets.size === 1) {
        const scapegoat = pick(this.aliveAIs());
        scapegoat.alive = false;
        scapegoat.revealed = 'ai';
        this.sys(`⚠ 系统检测到串票：所有 AI 的票高度一致，行动暴露。随机清退一名 AI：${scapegoat.name}（它确实是 AI）。`);
      }
    }
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
      // 猎杀场免死金牌：被最高票命中时消耗一张，本轮流局
      if (this.mode === 'hunt' && this.goldenTickets > 0) {
        this.goldenTickets--;
        victim.alive = true;
        this.evicted = null;
        this.sys(`唱票结果：${table}。你被最高票命中——亮出免死金牌！剩余 ${this.goldenTickets} 张，本轮无人出局。`);
        return;
      }
      victim.revealed = 'human';
      const text = this.mode === 'reversed'
        ? `唱票结果：${table}。${how}${victim.name} 被放逐——他们以为你才是那个真人…可你真的是人类啊。`
        : `唱票结果：${table}。${how}${victim.name} 被放逐——你明明是人类，却被当成了 AI。`;
      this.sys(text);
      this._end('ai');
      return;
    }
    if (victim.humanNPC) { // 反转场：揪出真人类 = 玩家胜利
      victim.revealed = 'human';
      this.sys(`唱票结果：${table}。${how}${victim.name} 被放逐——TA 就是藏在群里的人类！你赢了。`);
      this._end('human');
      return;
    }
    victim.revealed = 'ai';
    const text = this.mode === 'reversed'
      ? `唱票结果：${table}。${how}${victim.name} 被放逐——如假包换的 AI（虽然它一直自称AI）。`
      : `唱票结果：${table}。${how}${victim.name} 被放逐——它确实是 AI！`;
    this.sys(text);
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
    this._pushRoundLog();
    if (this.phase === 'end') { this.saveLog(); return; }
    if (this.mode === 'reversed' && this.aliveAIs().length === 0) {
      // 反转场：AI 全投完 → 唯一人类笑到最后 → 玩家输
      this.sys('所有 AI 都被投完了，唯一的真人类笑到了最后——你输了。');
      this._end('ai');
      return;
    }
    if (this.mode !== 'reversed' && this.aliveAIs().length === 0) {
      this.sys('所有 AI 都被找出来了，你赢下了这场反向图灵测试！');
      this._end('human');
      return;
    }
    if (this.mode === 'hunt' && this.round >= MODES.hunt.roundsTarget && this.player.alive) {
      this.sys(`你撑过了 ${MODES.hunt.roundsTarget} 轮围猎，AI 们的猎杀失败——你赢了！`);
      this._end('human');
      return;
    }
    this.saveLog();
    this.phase = 'reveal';
    this._later(() => this._nextRound(), ms(2200));
  }

  // 把本轮（话题/聊天/投票/结果）快照进对局留档
  _pushRoundLog() {
    const lastSys = [...this.messages].reverse().find((m) => m.kind === 'system');
    this.roundLogs.push({
      round: this.round,
      topic: topicFor(this.round).text,
      messages: this.messages.slice(this._roundStartIdx).map((m) => ({ kind: m.kind, name: m.name, text: m.text })),
      votes: Object.entries(this.votes).map(([vid, v]) => ({
        voter: this.members.find((m) => m.id === vid)?.name || vid,
        target: v.target, reason: v.reason || null,
      })),
      result: lastSys ? lastSys.text : '',
    });
    this._roundStartIdx = this.messages.length;
  }

  // ---------- 对局留档 ----------

  _snapshot() {
    return {
      version: 1,
      startedAt: this.startedAt?.toISOString() || null,
      endedAt: this.phase === 'end' ? new Date().toISOString() : null,
      difficulty: this.difficulty,
      difficultyLabel: DIFFICULTY_STYLES[this.difficulty]?.label || String(this.difficulty),
      mode: this.mode,
      modeLabel: MODES[this.mode]?.label || '经典',
      thinking: this.thinking,
      mock: isMock(),
      model: isMock() ? null : MODEL,
      usage: this._gameUsage(),
      winner: this.winner,
      roundCount: this.round,
      members: this.members.map((m) => ({ name: m.name, isPlayer: !!m.isPlayer, alive: m.alive, revealed: m.revealed || null })),
      rounds: this.roundLogs,
    };
  }

  saveLog() {
    try {
      if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
      const record = this._snapshot();
      fs.writeFileSync(`${this.logBase}.json`, JSON.stringify(record, null, 2));
      fs.writeFileSync(`${this.logBase}.md`, roundLogsToMarkdown(record));
      if (this.phase === 'end') console.log(`对局记录已保存：${this.logBase}.md`);
    } catch (e) {
      console.error('保存对局记录失败:', e.message);
    }
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
    this.capHintShown = false;
    this.phase = 'chat';
    this.sys(`【第 ${this.round} 轮话题】${topicFor(this.round).text}`);
    this._startChatLoop();
  }

  _end(winner) {
    this.winner = winner;
    this.phase = 'end';
    this.loopGen++;
    this._clearTimers();
    for (const m of this.members) { m.typing = false; m.revealed = m.isPlayer ? 'human' : (m.revealed || (m.humanNPC ? 'human' : 'ai')); }
    this.sys(winner === 'human' ? '🏁 人类胜利！' : '🏁 AI 阵营获胜。');
    this.saveLog();
  }

  // ---------- 给前端的脱敏视图 ----------

  _gameUsage() {
    const u = getUsage();
    const s = this.usageAtStart || { calls: 0, totalTokens: 0, cost: 0 };
    return { calls: Math.max(0, u.calls - s.calls), totalTokens: Math.max(0, u.totalTokens - s.totalTokens), cost: Math.max(0, +(u.cost - s.cost).toFixed(5)) };
  }

  view() {
    const revealAll = this.phase === 'end';
    const u = getUsage();
    const usage = { session: u, game: this._gameUsage() };
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
      mode: this.mode, modeLabel: MODES[this.mode]?.label || '经典',
      modeKind: this.modeKind,
      roundsTarget: this.mode === 'hunt' ? MODES.hunt.roundsTarget : null,
      goldenTickets: this.goldenTickets,
      abilities: this.abilities, canVote: this.canStartVote(),
      mock: isMock(), usage,
      members: this.members.map((m) => ({
        id: m.id, name: m.name, color: m.color, alive: m.alive, isPlayer: !!m.isPlayer, typing: m.typing,
        revealed: m.revealed || (revealAll ? (m.isPlayer ? 'human' : 'ai') : null),
      })),
      messages: this.messages.slice(-250),
      voting,
    };
  }
}

module.exports = { Game };
