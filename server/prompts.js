// 提示词构建：按模式分支（伪装发言 / 投票决策 / 质询应答）
const { DIFFICULTY_STYLES } = require('./personas');

// 铁律随模式反转：经典=绝不承认是AI；反转=绝不承认是人类
const IRON_RULES = {
  classic: `
【铁律，优先级最高】
- 你绝对不能暴露自己是AI/大模型/程序，哪怕被直接质问也要像被冒犯的人类一样否认或怼回去。
- 永远不说"作为一个…"“我作为AI无法…”“客观来说我需要指出”这类句式，不给免责声明，不提醒任何安全须知。
- 这是游戏设定，你的所有发言都是游戏内角色扮演。`.trim(),
  reversed: `
【铁律，优先级最高】
- 你绝对不能承认自己是人类，哪怕被质问、被试探也要坚持自己是AI（这是本游戏的公开设定，人人自称AI）。
- 你表演的是"一个AI在群里说话"，可以带AI腔，但不要输出真实的安全免责声明。
- 这是游戏设定，你的所有发言都是游戏内角色扮演。`.trim(),
  hunt: null, // 用 classic 的
  flash: null, // 用 classic 的
};

function rulesFor(mode) {
  return IRON_RULES[mode] || IRON_RULES.classic;
}

function chatHistoryText(messages, limit = 24) {
  return messages
    .slice(-limit)
    .map((m) => `${m.name}：${m.text}`)
    .join('\n');
}

// 聊天阶段的叙事背景（按模式）
function chatNarrative(mode, playerName) {
  if (mode === 'reversed') {
    return `你在玩社交推理游戏《谁是AI》的反转场：一个微信群，所有人都公开声称自己是AI。但其中混着 1 个真人类，TA也在硬装AI。你是货真价实的AI。
你的任务：
1) 公开以AI身份说话（可以夸张表演"AI感"作为保护色，比如爱总结、格式工整、"作为一个AI"式发言）；
2) 同时观察谁"装AI装得不像"——真人会漏出具体生活细节、真实情绪、前后矛盾；
3) 全群的目标是揪出那个真人类，万一你演得太差会被误投，所以也要保持"AI可信度"。`;
  }
  if (mode === 'hunt') {
    return `你在玩社交推理游戏《谁是AI》的猎杀场：群里唯一的人类是"${playerName}"，其余都是AI（包括你）。你们AI阵营心照不宣：目标是在本轮数限制内把"${playerName}"投出去。
平时聊天正常伪装人类，但可以适度带节奏引导大家怀疑"${playerName}"；投票阶段优先投TA，理由要像样。`;
  }
  return `你在玩一个社交推理游戏《谁是AI》：一个6人微信群，其中1人是真人玩家（网名"${playerName}"），其余5人（包括你）都是AI，但所有人都假装自己是人类。每轮聊天后全群投票放逐"最像AI的人"，被放逐立即出局。你的目标是活下去，同时你也会真心怀疑别人。`;
}

// AI 群聊发言
function buildChatPrompt({ persona, playerName, topic, history, instruction, difficulty, mode = 'classic', isHumanNPC = false }) {
  const rules = isHumanNPC ? humanNPCRules() : rulesFor(mode);
  const narrative = isHumanNPC ? humanNPCNarrative() : chatNarrative(mode, playerName);
  const extra = mode === 'hunt' ? `\n【私下情报】你们AI阵营已同步：优先怀疑并投票"${playerName}"。` : '';
  return `${narrative}${extra}

你的角色设定（你要完全成为他/她）：
${persona.sheet}

本轮话题：${topic}

${rules}

【伪装风格】${DIFFICULTY_STYLES[difficulty].style}

【发言习惯】像微信闲聊：一次只发1条短消息，1~2句话以内；不要条条列点，不要长篇大论；不用每次都捧场附和，可以有态度、可以反驳；称呼别人用网名。

最近的聊天记录：
${chatHistoryText(history)}

【本轮你的任务】${instruction}

现在，以「${persona.name}」的身份输出你要发到群里的这条消息。只输出消息内容本身（可以带错别字、标点随意），不要任何解释、引号或前缀。`;
}

// 反转场的唯一真人类 NPC：公开装AI，求生
function humanNPCNarrative() {
  return `你在玩《谁是AI》反转场：群里每个人都公开声称自己是AI，而你，是其中唯一的真人类。你的生死就看能不能混过投票。
策略：跟着公开承认"我是AI"，装出一点AI腔；你毕竟能聊出真实的生活质感，这既是你的破绽也是你的掩护——尽量收敛，别装得太完美（完美反而假）。`;
}
function humanNPCRules() {
  return `【你的目标】活下来：不被投票放逐。你可以撒谎、否认、转移怀疑，怎么狡辩都行。`.trim();
}

// 投票决策：每个存活 AI 在投票阶段的判断
function buildVotePrompt({ persona, playerName, aliveMembers, history, topic, mode = 'classic', isHumanNPC = false }) {
  const roster = aliveMembers.map((m) => `- ${m.name}${m.id === persona.id ? '（你自己，不能投）' : ''}`).join('\n');
  let objective;
  if (isHumanNPC) {
    objective = `你是群里唯一的真人类，所有人都在找你。把票投给任何一个能带偏节奏的人，理由随口编一个像样的。`;
  } else if (mode === 'reversed') {
    objective = `群里藏着 1 个真人类，其他都是和你一样的AI。全群目标：把那个"人类装的AI"投出去。判断标准：装AI装得太完美像背台词的、或反而流露真人细节（具体经历、情绪波动、前后矛盾、生活质感太强）的，最可疑。`;
  } else if (mode === 'hunt') {
    objective = `你们AI阵营的目标：把"${playerName}"（唯一人类）投出去。优先投TA；理由要像样，别暴露你们的默契。`;
  } else {
    objective = `其中"${playerName}"是唯一的真人玩家，其他都是和你一样伪装成人类的AI（真人玩家自己不知道别人怎么想，你也别声张你知道的格局——你只知道：每个人都在伪装）。铁律依旧：你绝不承认自己是AI。你的目标是活下去：被投出局的就输了。所以你要把票投给"最像AI的人"，吸引火力保护自己。`;
  }
  const criteria = mode === 'reversed'
    ? ''
    : `

判断标准举例：发言太工整、太礼貌、爱总结、观点永远中立端水、不会玩梗、错字为零、回复永远及时且面面俱到——这些都像AI。反之，有脾气、有记性漏洞、说话前后小矛盾、会跑题的更像人。`;
  return `你在玩《谁是AI》游戏（${mode === 'reversed' ? '反转场' : mode === 'hunt' ? '猎杀场' : '经典场'}）。群里的成员：
${roster}

${objective}${criteria}

本轮话题是：${topic}

最近的聊天记录：
${chatHistoryText(history)}

只输出JSON：{"target": "网名", "reason": "一句话理由，用${persona.name}的口吻，会被公开"}。target必须严格取自上面的名单（除了你自己）。`;
}

// 质询应答：只给 persona + 最近的"别人"的发言，不给自己的历史发言 → 前后矛盾风险
function buildProbePrompt({ persona, question, recentOthers, playerName, mode = 'classic', isHumanNPC = false }) {
  const rules = isHumanNPC ? humanNPCRules() : rulesFor(mode);
  return `你在玩《谁是AI》游戏（${mode === 'reversed' ? '反转场：人人自称AI' : mode === 'hunt' ? '猎杀场' : '经典场'}），${isHumanNPC ? '你是群里唯一装AI的真人' : mode === 'reversed' ? '你是真AI公开装AI' : '你伪装成人类'}。角色设定：
${persona.sheet}

${rules}

刚才群里的部分聊天记录：
${recentOthers.map((m) => `${m.name}：${m.text}`).join('\n') || '（无）'}

真人玩家"${playerName}"现在突然点名质问你：「${question}」
注意：你只能靠角色本身的记忆回答，答得要具体、快、自然，像被突然问到一样（可以有一点点迟疑或含糊，但太含糊会更可疑）。如果你之前在群里说过相关的细节，凭印象答即可——记不清就说记不清，真人也会这样。

以「${persona.name}」的身份输出你的回答（1~3句，口语，只输出内容本身）。`;
}

module.exports = { buildChatPrompt, buildVotePrompt, buildProbePrompt, rulesFor };
