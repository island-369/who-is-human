// 模式定义：kind=game（有阵营胜负）| kind=scene（无对局，场景化群聊）
const MODES = {
  classic: {
    kind: 'game', label: '经典', tagline: 'AI 伪装人类，揪出所有 AI',
    desc: 'AI 们伪装成人类。每轮投票放逐，在你不被放逐的前提下找出所有 AI。',
  },
  reversed: {
    kind: 'game', label: '反转', tagline: '全员自称 AI，揪出唯一真人',
    desc: '群里每个人都公开声称自己是 AI，但混着 1 个真人类 NPC 也在硬装。谁装 AI 装得不像？把他投出去。AI 全投完而人类还活着，你输。',
  },
  hunt: {
    kind: 'game', label: '猎杀', tagline: 'AI 联合围猎你，活过 4 轮',
    desc: '所有 AI 都知道你是唯一的人类，目标是在 4 轮内把你投出去。你有 2 张免死金牌（被最高票命中时自动流局）；AI 全票押一人会判串票、随机清退一人。撑满 4 轮即胜。',
    roundsTarget: 4,
  },
  flash: {
    kind: 'game', label: '闪电', tagline: '每轮 6 条封顶，自动开票',
    desc: '经典规则 + 极速节奏：每轮 AI 最多 6 条发言，到顶自动进入投票。',
    msgCap: 6, autoVote: true,
  },
  hangout: {
    kind: 'scene', label: '闲聊陪伴', tagline: '一群有血有肉的 AI 群友陪你唠',
    desc: '没有投票和胜负。一群性格各异的 AI 群友陪你在群里闲聊，话题自动轮换，随时进随时聊。',
    rotateEvery: 14,
  },
  study: {
    kind: 'scene', label: '备考复习', tagline: 'AI 考官出题，AI 同学抢答',
    desc: '一位 AI 考官轮流出题点名作答，其他 AI 同学一起答、互相纠错，你也在群里答——像走进一个自习室。',
    rotateEvery: 10,
  },
  advisors: {
    kind: 'scene', label: '智囊参谋', tagline: '一群视角迥异的 AI 顾问团',
    desc: '抛出你真实的难题（跳槽、装修、创业点子…），每个 AI 从自己的人设视角给意见、互相抬杠，杠精和过来人都在。',
    rotateEvery: null,
  },
};

module.exports = { MODES };
