// LLM 客户端：OpenAI 兼容 /chat/completions；未配置 key 时自动进入 mock 模式
// 配置来源：环境变量或项目根目录 .env（零依赖解析，不覆盖已有环境变量）
const fs = require('node:fs');
const path = require('node:path');

try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* .env 解析失败则忽略，继续用环境变量 */ }

const BASE_URL = process.env.LLM_BASE_URL || '';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || '';
const FORCE_MOCK = process.env.MOCK === '1';

const isMock = () => FORCE_MOCK || !(BASE_URL && API_KEY && MODEL);

async function chat(messages, { temperature = 0.95, max_tokens = 1200 } = {}) {
  const body = { model: MODEL, messages, temperature, max_tokens };
  if (/openrouter/i.test(BASE_URL)) body.reasoning = { enabled: false }; // 推理模型关思考：回复快、token 省
  const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM 返回为空');
  return text;
}

async function chatJSON(messages, { temperature = 0.7, max_tokens = 2000 } = {}) {
  const raw = await chat(messages, { temperature, max_tokens });
  const m = raw.match(/\{[\s\S]*\}/); // 容错：剥掉 markdown 代码块等杂质
  if (!m) throw new Error(`无法解析 JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

// ---------- mock 引擎：无 key 时让整个游戏可玩、可验证 ----------

const MOCK_LINES = {
  老K: [
    '不是，这话题有啥好聊的',
    '讲道理 我上周熬到四点改线上bug 你们那都不叫熬夜',
    '又端水 又端水，你们发现没，说话越客气的越有问题',
    '我先把话放这：群里肯定有人回消息从不打错字，那就是它',
    '微笑',
    '行吧 那我认真说一个 我讨厌聚餐 效率太低',
    '楼主这问题问的 跟面试似的',
  ],
  糖糖: [
    '哈哈哈我来我来！！',
    '呜呜呜我上周追剧追到五点 第二天早八差点当场去世(≧▽≦)',
    '对对对就是这个！！',
    '等下 你们说的什么呀 我没看懂 但感觉好厉害',
    '啊啊啊不要吵架呀',
    '我讨厌香菜！！怎么会有人爱吃香菜啦',
    '我讲一个我小学把墨水喝了的糗事 你们要听吗哈哈哈',
  ],
  陈叔: [
    '小伙子们不要在熬夜了！我在坚持喝枸杞水！',
    '年轻人要注意身体，身体是革命的本钱！！！',
    '我象你们这么大的时候已经在厂里干活了',
    '在说一次，养生不是迷信，是科学',
    '我讨厌什么共享单车，乱七八糟堆在哪里！',
    '我小时候偷生产队的梨子 被追了二里地 哈哈',
  ],
  Mia: [
    'vibe 不对，这个群的 vibe 很微妙',
    '熬什么夜，我这叫亚洲时差自适应',
    '有一说一，刚才谁发言那么工整，一看就没上过班',
    'hahaha 笑死，端水大师出现了',
    '我讨厌团建，尤其是要素质拓展的那种，谢谢',
    '改稿改到怀疑人生的第9天，勿扰',
  ],
  阿宅: [
    '草 这话题我熟',
    '熬到三点看番罢了 典中典',
    'u1s1 刚那条发言一股AI味hhh',
    '绷不住了，有人连表情都不用，真人哪有这么聊天的',
    '我讨厌体育课 谁懂',
    '讲个笑话：我绩点',
    'hhh 有一说一 这群有点好笑',
  ],
};

const MOCK_PROBE = [
  '啊？突然问我这个干嘛',
  '就…正常吃的吧，忘了，好像是外卖',
  '昨天？昨天我在打游戏啊，问这个干嘛哈哈',
  '这什么查户口环节，行吧我配合一下，吃了米饭',
];

const MOCK_VOTE_REASONS = [
  '它发言太整齐了，看着就不对劲',
  '直觉，别问',
  '它从不接梗，我早觉得有问题',
  '回消息太快太全，谁人类这样啊',
  '我盯它很久了，就是它',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function mockChat({ persona }) {
  return pick(MOCK_LINES[persona.name] || MOCK_LINES['老K']);
}

async function mockVote({ persona, candidates }) {
  const target = pick(candidates);
  return { target, reason: pick(MOCK_VOTE_REASONS) };
}

async function mockProbe() {
  return pick(MOCK_PROBE);
}

module.exports = { isMock, chat, chatJSON, mockChat, mockVote, mockProbe, MODEL, BASE_URL };
