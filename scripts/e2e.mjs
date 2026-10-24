// 端到端流程验证脚本（配合 MOCK=1 TIMESCALE=0.2 的服务端使用）
// 用法：MOCK=1 TIMESCALE=0.2 node server/index.js &  node scripts/e2e.mjs
const BASE = process.env.BASE || 'http://localhost:3690';

const api = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${label}`);
  if (!cond) failures++;
};

const state = async () => (await api('/api/state')).data;
const waitPhase = async (phases, timeout = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await state();
    if (phases.includes(s.phase)) return s;
    await sleep(300);
  }
  throw new Error(`等待阶段 ${phases} 超时`);
};

(async () => {
  console.log('== 开局 ==');
  let r = await api('/api/start', { nickname: '测试员', difficulty: 3 });
  check(r.data.ok === true, 'POST /api/start ok');

  let s = await waitPhase(['chat']);
  check(s.round === 1 && s.phase === 'chat', '进入第 1 轮聊天');
  check(s.members.length === 6 && s.members.filter((m) => m.isPlayer).length === 1, '6 名成员（1 玩家 + 5 AI）');
  check(s.members.some((m) => m.isPlayer && m.name === '测试员'), '玩家昵称正确');

  // 等待 AI 消息累积到可投票
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    s = await state();
    if (s.canVote) break;
    await sleep(400);
  }
  check(s.canVote === true, '累计 4 条 AI 发言后解锁投票');
  const aiMsgs = s.messages.filter((m) => m.kind === 'chat' && m.from !== 'p0');
  check(aiMsgs.length >= 4, `AI 已发言 ${aiMsgs.length} 条`);

  console.log('== 玩家发言 / 质询 / 异常输入 ==');
  r = await api('/api/action', { type: 'say', text: '哈哈你们聊得也太投入了吧' });
  check(r.data.ok === true, '玩家发言 ok');

  const aTarget = s.members.find((m) => !m.isPlayer && m.alive);
  r = await api('/api/action', { type: 'probe', target: aTarget.id, question: '你昨晚到底干嘛了？' });
  check(r.data.ok === true, '质询道具 ok');
  await sleep(2500);
  s = await state();
  check(s.abilities.probe === 1, '质询次数 2→1');
  check(s.messages.some((m) => m.text.includes('质询')), '质询公告已广播');

  r = await api('/api/action', { type: 'vote', target: aTarget.id });
  check(r.status === 400, '聊天阶段投票被拒绝');

  console.log('== 投票 ==');
  r = await api('/api/action', { type: 'startVote' });
  check(r.data.ok === true, '发起投票 ok');
  s = await state();
  check(s.phase === 'vote', '进入投票阶段');

  r = await api('/api/action', { type: 'say', text: '现在还能说话吗' });
  check(r.status === 400, '投票阶段发言被拒绝');

  // 等唱票停在"等玩家"
  let waited = 0;
  while (!s.voting?.waitingPlayer && s.phase === 'vote' && waited < 30000) {
    s = await state(); await sleep(300); waited += 300;
  }
  check(s.voting?.waitingPlayer === true, '唱票暂停等待玩家压轴投票');
  r = await api('/api/action', { type: 'vote', target: aTarget.id });
  check(r.data.ok === true, '玩家投票 ok');

  s = await waitPhase(['reveal', 'chat', 'end'], 30000);
  check(s.phase !== 'vote', '计票完成离开投票阶段');
  const sysText = s.messages.filter((m) => m.kind === 'system').map((m) => m.text).join('\n');
  const deadCount = s.members.filter((m) => !m.alive).length;
  check(/唱票结果/.test(sysText) && (/平票/.test(sysText) || deadCount >= 1),
    `本轮投票已结算（放逐或平票均合法，当前死亡 ${deadCount} 人）`);

  console.log('== 连续多轮直到终局 ==');
  const deadline = Date.now() + 150000;
  let lastLog = '';
  while (s.phase !== 'end' && Date.now() < deadline) {
    if (s.phase === 'chat' && s.canVote) {
      await api('/api/action', { type: 'startVote' });
      let s2 = await state();
      // 若唱票停在等玩家则投一个 AI
      while (s2.phase === 'vote') {
        if (s2.voting?.waitingPlayer) {
          const t = s2.members.find((m) => !m.isPlayer && m.alive);
          if (!t) break;
          await api('/api/action', { type: 'vote', target: t.id });
        }
        s2 = await state();
        await sleep(300);
      }
      s = s2;
    } else {
      s = await state();
      await sleep(500);
    }
    const log = `r${s.round}:${s.phase} 死亡${s.members.filter((m) => !m.alive).length}`;
    if (log !== lastLog) { console.log('  …', log); lastLog = log; }
  }
  check(s.phase === 'end', '游戏到达终局（150s 内）');
  check(['human', 'ai'].includes(s.winner), `胜负已判定：${s.winner}`);
  check(s.members.every((m) => m.revealed), '终局全员身份揭示');

  console.log(failures === 0 ? '\n🎉 全部断言通过' : `\n💥 ${failures} 个断言失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('E2E 异常:', e.message); process.exit(1); });
