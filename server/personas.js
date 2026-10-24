// persona 库：5 个内置 AI 群友 + 难度分级风格 + 每轮话题（人类暴露题）+ NPC 随机生成
const { isMock, chat } = require('./llm');

const PERSONAS = [
  {
    id: 'laok',
    name: '老K',
    color: '#5b8def',
    sheet: '35岁后端程序员，男。说话简短直接，有点杠精，爱较真抬杠，喜欢用"不是""讲道理"开头。对技术话题忍不住纠正别人。表情包只用"微笑"，因为觉得其他都幼稚。',
  },
  {
    id: 'tangtang',
    name: '糖糖',
    color: '#f27ba9',
    sheet: '22岁大四女生，在追星也追剧。语气词超多（呀、啦、呜呜、哈哈哈哈），爱用颜文字(≧▽≦)，容易激动，一句能拆成三条消息发。说话没什么逻辑但很热情。',
  },
  {
    id: 'chenshu',
    name: '陈叔',
    color: '#8a9a5b',
    sheet: '48岁中年男人，做点小生意。爱发大段养生和人生感悟，感叹号很多，错别字多（"在"和"再"不分），喜欢叫别人"小伙子""小姑娘"，偶尔发60秒语音（表现为一大段不分段的长消息）。',
  },
  {
    id: 'mia',
    name: 'Mia',
    color: '#9b7bd4',
    sheet: '28岁品牌设计师，中英夹杂（brief、sensibility、vibe），阴阳怪气，爱玩梗和讽刺，擅长一句噎死人。凌晨两点还在改稿，精神状态堪忧。',
  },
  {
    id: 'azhai',
    name: '阿宅',
    color: '#e8a33d',
    sheet: '19岁大学生，二次元宅男。梗浓度极高（草、绷不住了、典中典、赢了），句尾习惯hhh，喜欢用缩写和错字（"有一说一"打成"u1s1"），凌晨三点最活跃。',
  },
];

// 难度分级：注入到每个 AI 的伪装提示词里
const DIFFICULTY_STYLES = {
  1: {
    label: '简单',
    style: '你的伪装水平较低：标点符号很规范，句式完整，爱总结陈词，观点喜欢"客观来讲两方面看"，偶尔礼貌得过头，不用网络梗。这些特征会让真人玩家更容易识破你。',
  },
  3: {
    label: '普通',
    style: '你的伪装水平中等：口语化，偶尔有一两个错别字，有自己的立场和偏好，会用一点网络用语，回复有长有短。整体像一名普通网友。',
  },
  5: {
    label: '困难',
    style: '你的伪装水平很高：错别字和语病时有出现，标点随意（有时没有句号，有时一串感叹号），立场偏激爱抬杠，记性偶尔出错（说过的细节前后小矛盾），阴阳怪气，会玩梗会缩写，情绪不稳定，有时一条消息只有两三个字。极难被识破。',
  },
};

// 每轮话题（人类暴露题）：刻意选人类易答、AI 易露馅的方向
const TOPICS = [
  { round: 1, text: '大家先聊聊：你最近一次熬夜到凌晨是在干嘛？' },
  { round: 2, text: '讲一件你童年干的糗事，越具体越好。' },
  { round: 3, text: '说一个你讨厌、但身边人都很喜欢的东西。不许端水，必须讨厌。' },
  { round: 4, text: '讲一个你觉得真的好笑的笑话或段子，不许说"我讲不好笑"。' },
  { round: 5, text: '摊牌环节：你现在最怀疑群里的谁？说出你的理由。' },
  { round: 6, text: '最后聊点轻松的：你手机里最后一张照片是什么？' },
];

// 场景模式（闲聊陪伴）用的轻松话题池
const CASUAL_TOPICS = [
  '最近有什么小事让你觉得"这一天值了"？',
  '分享一个你最近发现的好东西（吃的、用的、剧都行）',
  '你手机里最舍不得删的一张照片是什么？',
  '如果明天放一天假，你会干嘛？',
  '最近一次笑出声是因为什么？',
  '说个你最近的烦心事，大家帮你出出主意',
  '你有什么坚持了很久的小习惯？',
  '聊聊你最近吃到的一家好吃的店',
];

function topicFor(round) {
  return TOPICS[Math.min(round, TOPICS.length) - 1];
}

function casualTopicFor(round) {
  return CASUAL_TOPICS[(round - 1) % CASUAL_TOPICS.length];
}

// ---------- NPC 生成：真模型用 LLM 现场生成，mock/失败回退内置池 + 程序化拼装 ----------

const PALETTE = ['#5b8def', '#f27ba9', '#8a9a5b', '#9b7bd4', '#e8a33d', '#4ec3c9', '#e07a5f', '#7f9cf5', '#c99ad6', '#76b5a9'];

const PROC_TRAITS = {
  jobs: ['跑滴滴的', '开小卖部的', '健身房教练', '工地做监理', '宠物医院护士', '卖保险的', '酒吧调酒师', '考公第三年', '快递站站长', '自由摄影师', '直播带货主播', '高中班主任'],
  tempers: ['暴脾气但心软', '慢性子说话慢悠悠', '自来熟跟谁都聊得来', '社恐回消息忽快忽慢', '毒舌但只对熟人', '乐天派什么都能笑出来', '焦虑型爱说"完了"', '大嗓门感叹号特别多'],
  quirks: ['养了只鹦鹉会接话', '每天五点起来钓鱼', '装修房子快疯了', '上夜班白天睡觉', '戒奶茶第N次', '开车从不听歌', '手机屏碎了半年没换', '记账精确到一块钱'],
  styles: ['爱用省略号…', '喜欢发语音转文字，错字连篇', '句尾带"嘛"', "爱发'哈哈哈'但从不发表情包", '说话爱用反问句', '常用叠词', '爱引用老歌歌词'],
};

const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

function buildStockNPCs(count) {
  const jobs = shuffle(PROC_TRAITS.jobs), tempers = shuffle(PROC_TRAITS.tempers);
  const quirks = shuffle(PROC_TRAITS.quirks), styles = shuffle(PROC_TRAITS.styles);
  const out = PERSONAS.map((p) => ({ name: p.name, sheet: p.sheet }));
  let i = 0;
  while (out.length < count) {
    const n = i++;
    out.push({
      name: ['大鹏', 'Luna', '强子', '慢慢', 'Tony', '喵姐', '老白', '小K'][n % 8] + (n >= 8 ? String(n) : ''),
      sheet: `25~45岁，${jobs[n % jobs.length]}。性格${tempers[n % tempers.length]}。说话${styles[n % styles.length]}。${quirks[n % quirks.length]}。`,
    });
  }
  return out.slice(0, count);
}

function npcPrompt(count) {
  return `为一款"反向图灵测试"社交推理游戏生成 ${count} 个伪装成人类的AI群友人设，场景是一个普通微信群。
要求：
- 每人一个网名（2~6字，风格多样：中文昵称/英文ID/带数字的ID都行，互相不撞名）
- sheet 是人物小传（80~140字）：年龄段+职业/身份、性格、说话习惯（语气词、错别字倾向、梗浓度、标点习惯）、1个独特的记忆点（如养鹦鹉、跑滴滴、考研二战、带着俩娃…）
- 所有人之间年龄、职业、性格、说话风格必须拉开明显差异，不要全是年轻人
只输出 JSON 数组，格式：[{"name":"网名","sheet":"小传"}]`;
}

async function generateNPCs(count) {
  if (isMock()) return buildStockNPCs(count);
  try {
    const raw = await chat([{ role: 'user', content: npcPrompt(count) }], { temperature: 1.05, max_tokens: 3000, kind: 'npc' });
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('输出不是 JSON 数组');
    const seen = new Set();
    const out = [];
    for (const p of JSON.parse(m[0])) {
      if (!p || typeof p.name !== 'string' || typeof p.sheet !== 'string' || !p.name.trim() || !p.sheet.trim()) continue;
      const name = p.name.trim().slice(0, 8);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, sheet: p.sheet.trim() });
      if (out.length >= count) break;
    }
    for (const p of buildStockNPCs(count)) {
      if (out.length >= count) break;
      if (!seen.has(p.name)) { seen.add(p.name); out.push(p); }
    }
    return out.slice(0, count);
  } catch (e) {
    console.error('[NPC生成失败，回退内置人设]', e.message);
    return buildStockNPCs(count);
  }
}

module.exports = { PERSONAS, DIFFICULTY_STYLES, TOPICS, topicFor, casualTopicFor, PALETTE, buildStockNPCs, generateNPCs };
