import { levels } from '../data/gameData'
import type {
  BackgroundId,
  Difficulty,
  LevelDefinition,
  LibraryProgressEntry,
  WordEntry,
} from '../types'

export function normalizeSpeech(input: string) {
  return input
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}?' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isAnswerCorrect(answer: string, target: string) {
  return normalizeSpeech(answer) === normalizeSpeech(target)
}

export function pickWordsForLevel(
  wordBank: WordEntry[],
  progress: Record<string, LibraryProgressEntry>,
  level: LevelDefinition,
) {
  const candidates = wordBank
    .filter((word) => word.enabled && word.level === level.difficulty)
    .sort((left, right) => {
      const leftProgress = progress[left.id] ?? { seen: 0, correct: 0, wrong: 0 }
      const rightProgress = progress[right.id] ?? { seen: 0, correct: 0, wrong: 0 }
      const leftScore = leftProgress.correct - leftProgress.wrong - leftProgress.seen * 0.2
      const rightScore = rightProgress.correct - rightProgress.wrong - rightProgress.seen * 0.2
      return leftScore - rightScore
    })

  if (candidates.length <= level.wordCount) {
    return candidates
  }

  const offset = (level.number - 1) % candidates.length
  const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)]
  return ordered.slice(0, level.wordCount)
}

export function levelByNumber(number: number) {
  return levels.find((level) => level.number === number) ?? levels[0]
}

export function backgroundLabel(background: BackgroundId) {
  switch (background) {
    case 'rainy':
      return '雨天球场'
    case 'starry':
      return '星空球场'
    default:
      return '晴天球场'
  }
}

export function difficultyColor(level: Difficulty) {
  switch (level) {
    case '中级':
      return '#4facee'
    case '高级':
      return '#8b67ff'
    default:
      return '#6af425'
  }
}

export function formatMinutes(minutes: number) {
  if (minutes < 60) {
    return `${minutes} 分钟`
  }

  const hours = Math.floor(minutes / 60)
  const remain = minutes % 60
  return remain === 0 ? `${hours} 小时` : `${hours} 小时 ${remain} 分钟`
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function formatDuration(seconds: number) {
  if (seconds < 60) {
    return `${seconds} 秒`
  }

  const minutes = Math.floor(seconds / 60)
  const remain = seconds % 60
  return remain === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remain} 秒`
}
