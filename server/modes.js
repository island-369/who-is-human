// 游戏模式定义：同一引擎，不同阵营结构与胜负条件
const MODES = {
  classic: {
    label: '经典',
    tagline: 'AI 伪装人类，揪出所有 AI',
    desc: 'AI 们伪装成人类。每轮投票放逐，在你不被放逐的前提下找出所有 AI。',
  },
  reversed: {
    label: '反转',
    tagline: '全员自称 AI，揪出唯一真人',
    desc: '群里每个人都公开声称自己是 AI，但混着 1 个真人类 NPC 也在硬装。谁装 AI 装得不像？把他投出去。AI 全投完而人类还活着，你输。',
  },
  hunt: {
    label: '猎杀',
    tagline: 'AI 联合围猎你，活过 4 轮',
    desc: '所有 AI 都知道你是唯一的人类，目标是在 4 轮内把你投出去。你不揪人，撑满 4 轮即胜。',
    roundsTarget: 4,
  },
  flash: {
    label: '闪电',
    tagline: '每轮 6 条封顶，自动开票',
    desc: '经典规则 + 极速节奏：每轮 AI 最多 6 条发言，到顶自动进入投票。',
    msgCap: 6,
    autoVote: true,
  },
};

module.exports = { MODES };
