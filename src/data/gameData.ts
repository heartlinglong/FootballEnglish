import type {
  CharacterOption,
  Difficulty,
  LevelDefinition,
  WordEntry,
  WorkshopBlock,
} from '../types'

export const characters: CharacterOption[] = [
  {
    id: 'bear',
    name: '小熊队长',
    englishName: 'Captain Bear',
    emoji: '🐻',
    accent: '#f4af25',
    description: '稳定控球，适合第一次进入足球英语小镇的小朋友。',
  },
  {
    id: 'rabbit',
    name: '闪电小兔',
    englishName: 'Rocket Rabbit',
    emoji: '🐰',
    accent: '#ff7aa2',
    description: '移动轻快，最适合喜欢节奏和速度的冒险家。',
  },
  {
    id: 'cat',
    name: '机灵小猫',
    englishName: 'Smarty Cat',
    emoji: '🐱',
    accent: '#61c6ff',
    description: '反应敏捷，专门挑战高正确率和连击表现。',
  },
]

const difficultyMap: Array<{
  difficulty: Difficulty
  start: number
  end: number
  background: LevelDefinition['background']
}> = [
  { difficulty: '初级', start: 1, end: 5, background: 'sunny' as const },
  { difficulty: '中级', start: 6, end: 10, background: 'rainy' as const },
  { difficulty: '高级', start: 11, end: 15, background: 'starry' as const },
]

export const levels: LevelDefinition[] = difficultyMap.flatMap((group) =>
  Array.from({ length: group.end - group.start + 1 }, (_, index) => {
    const number = group.start + index
    const wordCount =
      group.difficulty === '初级'
        ? 3 + (index % 3)
        : group.difficulty === '中级'
          ? 5 + (index % 3)
          : 8 + (index % 3)

    return {
      id: `L${number}`,
      number,
      difficulty: group.difficulty,
      wordCount,
      title:
        group.difficulty === '初级'
          ? '基础单词热身'
          : group.difficulty === '中级'
            ? '短语配合进攻'
            : '对话冠军赛',
      subtitle:
        group.difficulty === '初级'
          ? '踢飞基础词汇，熟悉角色和场地。'
          : group.difficulty === '中级'
            ? '把短语读完整，配合更快的节奏。'
            : '说出完整问答句，完成高阶挑战。',
      theme:
        group.difficulty === '初级'
          ? '动物与交通'
          : group.difficulty === '中级'
            ? '短语和动作表达'
            : '完整问答与情境表达',
      background: group.background,
    }
  }),
)

export const starterWords: WordEntry[] = [
  { id: 'panda', english: 'panda', chinese: '熊猫', level: '初级', category: '动物', phonetic: '/ˈpæn.də/', enabled: true },
  { id: 'goose', english: 'goose', chinese: '小鹅', level: '初级', category: '动物', phonetic: '/ɡuːs/', enabled: true },
  { id: 'dog', english: 'dog', chinese: '小狗', level: '初级', category: '动物', phonetic: '/dɔːɡ/', enabled: true },
  { id: 'cat', english: 'cat', chinese: '小猫', level: '初级', category: '动物', phonetic: '/kæt/', enabled: true },
  { id: 'notebook', english: 'notebook', chinese: '计划本', level: '初级', category: '物品', phonetic: '/ˈnəʊt.bʊk/', enabled: true },
  { id: 'sofa', english: 'sofa', chinese: '沙发', level: '初级', category: '物品', phonetic: '/ˈsəʊ.fə/', enabled: true },
  { id: 'car', english: 'car', chinese: '小汽车', level: '初级', category: '交通', phonetic: '/kɑːr/', enabled: true },
  { id: 'bus', english: 'bus', chinese: '公交车', level: '初级', category: '交通', phonetic: '/bʌs/', enabled: true },
  { id: 'taxi', english: 'taxi', chinese: '出租车', level: '初级', category: '交通', phonetic: '/ˈtæk.si/', enabled: true },
  { id: 'plane', english: 'plane', chinese: '飞机', level: '初级', category: '交通', phonetic: '/pleɪn/', enabled: true },
  { id: 'train', english: 'train', chinese: '火车', level: '初级', category: '交通', phonetic: '/treɪn/', enabled: true },
  { id: 'subway', english: 'subway', chinese: '地铁', level: '初级', category: '交通', phonetic: '/ˈsʌb.weɪ/', enabled: true },
  { id: 'snow', english: 'snow', chinese: '雪', level: '初级', category: '自然', phonetic: '/snəʊ/', enabled: true },
  { id: 'ultraman', english: 'Ultraman', chinese: '奥特曼', level: '初级', category: '卡通角色名', phonetic: '/ˈʌl.trə.mæn/', enabled: true },
  { id: 'a-small-dog', english: 'a small dog', chinese: '一只小狗', level: '中级', category: '短语', exampleSentence: 'Look, it is a small dog.', enabled: true },
  { id: 'red-sofa', english: 'red sofa', chinese: '红色沙发', level: '中级', category: '短语', exampleSentence: 'The red sofa is soft.', enabled: true },
  { id: 'take-the-bus', english: 'take the bus', chinese: '乘坐公交车', level: '中级', category: '动作短语', exampleSentence: 'We take the bus to school.', enabled: true },
  { id: 'yellow-taxi', english: 'a yellow taxi', chinese: '一辆黄色出租车', level: '中级', category: '短语', exampleSentence: 'I can see a yellow taxi.', enabled: true },
  { id: 'build-a-house', english: 'build a house', chinese: '搭一座房子', level: '中级', category: '动作短语', exampleSentence: 'Let us build a house.', enabled: true },
  { id: 'kick-the-ball', english: 'kick the ball', chinese: '踢足球', level: '中级', category: '动作短语', exampleSentence: 'Kick the ball into the goal.', enabled: true },
  { id: 'whats-this', english: "What's this? It's a panda.", chinese: '这是什么？它是一只熊猫。', level: '高级', category: '对话', exampleSentence: "What's this? It's a panda.", enabled: true },
  { id: 'where-is-the-bus', english: 'Where is the bus?', chinese: '公交车在哪里？', level: '高级', category: '对话', exampleSentence: 'Where is the bus?', enabled: true },
  { id: 'how-do-you-go', english: 'How do you go to school?', chinese: '你怎么去学校？', level: '高级', category: '对话', exampleSentence: 'How do you go to school?', enabled: true },
  { id: 'i-see-snow', english: 'I can see snow on the field.', chinese: '我能看到球场上的雪。', level: '高级', category: '对话', exampleSentence: 'I can see snow on the field.', enabled: true },
  { id: 'can-you-build', english: 'Can you build a house with me?', chinese: '你能和我一起搭房子吗？', level: '高级', category: '对话', exampleSentence: 'Can you build a house with me?', enabled: true },
]

export const workshopPalette: Array<Omit<WorkshopBlock, 'id' | 'x' | 'y'>> = [
  { type: 'rectangle', width: 180, height: 90, rotation: 0, scale: 1, color: '#ffcc6f', label: '长方形墙面' },
  { type: 'square', width: 100, height: 100, rotation: 0, scale: 1, color: '#6ec8ff', label: '正方形积木' },
  { type: 'triangle', width: 120, height: 110, rotation: 0, scale: 1, color: '#ff8d8d', label: '三角形屋顶' },
  { type: 'oval', width: 130, height: 90, rotation: 0, scale: 1, color: '#8adf8a', label: '椭圆形花园' },
  { type: 'roof', width: 220, height: 120, rotation: 0, scale: 1, color: '#ff8d5a', label: '屋顶' },
  { type: 'window', width: 90, height: 90, rotation: 0, scale: 1, color: '#d6f1ff', label: '窗户' },
  { type: 'door', width: 90, height: 150, rotation: 0, scale: 1, color: '#81563c', label: '门' },
  { type: 'chimney', width: 60, height: 130, rotation: 0, scale: 1, color: '#8e5a4f', label: '烟囱' },
]
