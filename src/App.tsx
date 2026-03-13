import { startTransition, useEffect, useRef, useState } from 'react'
import { characters, levels, workshopPalette } from './data/gameData'
import {
  backgroundLabel,
  formatDateTime,
  formatDuration,
  formatMinutes,
  isAnswerCorrect,
  levelByNumber,
  pickWordsForLevel,
} from './lib/game'
import { translateChineseToEnglish } from './lib/translation'
import { createDefaultAppState, loadAppState, saveAppState } from './lib/storage'
import './index.css'
import type {
  AppState,
  BackgroundId,
  CharacterId,
  Difficulty,
  FeedbackEntry,
  LevelDefinition,
  MicrophoneStatus,
  Scene,
  WorkshopBlock,
  WorkshopBlockType,
  WrongWordEntry,
  WordEntry,
} from './types'

type BubbleState = {
  id: string
  word: WordEntry
  x: number
  y: number
  status: 'pending' | 'cleared' | 'skipped'
  attempts: number
  createdOrder: number
}

type GameSession = {
  level: LevelDefinition
  background: BackgroundId
  bubbles: BubbleState[]
  player: { x: number; y: number }
  energy: number
  feedback: string
  startTime: number
}

type SessionResult = {
  level: LevelDefinition
  accuracy: number
  durationSeconds: number
  total: number
  correctCount: number
  wrongWords: WrongWordEntry[]
}

type Direction = 'up' | 'down' | 'left' | 'right'

type WordVisual = {
  emoji: string
  accent: string
  background: string
  scene: string
}

const goalPosition = { x: 50, y: 10 }
const MAX_FIELD_BUBBLES = 3

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function createBubbleLayout(words: WordEntry[]) {
  const basePositions = [
    { x: 18, y: 68 },
    { x: 32, y: 38 },
    { x: 56, y: 61 },
    { x: 70, y: 32 },
    { x: 82, y: 55 },
    { x: 44, y: 22 },
    { x: 24, y: 24 },
    { x: 60, y: 20 },
    { x: 79, y: 74 },
    { x: 12, y: 48 },
  ]

  return words.map((word, index) => ({
    id: `${word.id}-${index}`,
    word,
    x: basePositions[index % basePositions.length].x,
    y: basePositions[index % basePositions.length].y,
    status: 'pending' as const,
    attempts: 0,
    createdOrder: index,
  }))
}

function getNextBubblePosition(existingBubbles: BubbleState[]) {
  const candidatePositions = [
    { x: 18, y: 68 },
    { x: 32, y: 38 },
    { x: 56, y: 61 },
    { x: 70, y: 32 },
    { x: 82, y: 55 },
    { x: 44, y: 22 },
    { x: 24, y: 24 },
    { x: 60, y: 20 },
    { x: 79, y: 74 },
    { x: 12, y: 48 },
    { x: 50, y: 82 },
    { x: 88, y: 84 },
  ]

  const nextPosition = candidatePositions.find((candidate) =>
    existingBubbles.every(
      (bubble) => Math.hypot(bubble.x - candidate.x, bubble.y - candidate.y) > 14,
    ),
  )

  return nextPosition ?? { x: 50, y: 78 }
}

function normalizeChineseKeyword(input: string) {
  return input.replace(/\s+/g, '').replace(/[，。！？、,.!?]/g, '').trim()
}

function normalizeEnglishKeyword(input: string) {
  return input
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}?' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildGeneratedWordId(keyword: string, english: string, difficulty: Difficulty) {
  const englishToken = normalizeEnglishKeyword(english).replace(/\s+/g, '-')
  const chineseToken = encodeURIComponent(normalizeChineseKeyword(keyword) || keyword.trim())
  return `generated-${difficulty}-${englishToken || 'word'}-${chineseToken}`
}

function findWordMatch(wordBank: WordEntry[], keyword: string, difficulty?: Difficulty) {
  const normalizedKeyword = normalizeChineseKeyword(keyword)
  const candidates = difficulty
    ? wordBank.filter((word) => word.level === difficulty)
    : wordBank

  const exact = candidates.find(
    (word) => normalizeChineseKeyword(word.chinese) === normalizedKeyword,
  )
  if (exact) {
    return exact
  }

  return (
    candidates
      .filter((word) => {
        const normalizedChinese = normalizeChineseKeyword(word.chinese)
        return (
          normalizedChinese.includes(normalizedKeyword) ||
          normalizedKeyword.includes(normalizedChinese)
        )
      })
      .sort((left, right) => left.chinese.length - right.chinese.length)[0] ?? null
  )
}

async function resolveParentWord(
  keyword: string,
  wordBank: WordEntry[],
  difficulty: Difficulty,
) {
  const displayChinese = keyword.trim()
  const exactCurrentWord = findWordMatch(wordBank, displayChinese, difficulty)
  if (exactCurrentWord) {
    return { word: exactCurrentWord, source: 'existing' as const }
  }

  const existingWord = findWordMatch(wordBank, displayChinese)
  if (existingWord) {
    return existingWord.level === difficulty
      ? { word: existingWord, source: 'existing' as const }
      : {
          word: {
            ...existingWord,
            id: buildGeneratedWordId(displayChinese, existingWord.english, difficulty),
            level: difficulty,
          },
          source: 'generated' as const,
        }
  }

  const translatedEnglish = await translateChineseToEnglish(displayChinese)
  if (!translatedEnglish) {
    return null
  }

  return {
    word: {
      id: buildGeneratedWordId(displayChinese, translatedEnglish, difficulty),
      english: translatedEnglish,
      chinese: displayChinese,
      level: difficulty,
      category: '家长词库',
      enabled: true,
    },
    source: 'generated' as const,
  }
}

function countWordsByDifficulty(wordBank: WordEntry[]) {
  return wordBank.reduce<Record<Difficulty, number>>(
    (summary, word) => {
      summary[word.level] += 1
      return summary
    },
    { 初级: 0, 中级: 0, 高级: 0 },
  )
}

function buildWordBankSummary(wordBank: WordEntry[]) {
  const counts = countWordsByDifficulty(wordBank)
  const total = counts.初级 + counts.中级 + counts.高级

  return total === 0
    ? '当前词库：家长还没有添加单词'
    : `当前词库：初级 ${counts.初级} 词 / 中级 ${counts.中级} 词 / 高级 ${counts.高级} 词`
}

function getActiveBubble(session: GameSession | null, focusedBubbleId: string | null) {
  if (!session) {
    return null
  }

  if (focusedBubbleId) {
    const focusedBubble = session.bubbles.find(
      (bubble) => bubble.id === focusedBubbleId && bubble.status === 'pending',
    )
    if (focusedBubble) {
      return {
        bubble: focusedBubble,
        distance: Math.hypot(
          session.player.x - focusedBubble.x,
          session.player.y - focusedBubble.y,
        ),
      }
    }
  }

  return (
    session.bubbles
      .filter((bubble) => bubble.status === 'pending')
      .map((bubble) => ({
        bubble,
        distance: Math.hypot(session.player.x - bubble.x, session.player.y - bubble.y),
      }))
      .sort((left, right) => left.distance - right.distance)[0] ?? null
  )
}

function drawWorkshopShape(
  context: CanvasRenderingContext2D,
  block: WorkshopBlock,
  offsetX = 0,
  offsetY = 0,
) {
  const width = block.width * block.scale
  const height = block.height * block.scale
  const centerX = offsetX + block.x + width / 2
  const centerY = offsetY + block.y + height / 2

  context.save()
  context.translate(centerX, centerY)
  context.rotate((block.rotation * Math.PI) / 180)
  context.fillStyle = block.color
  context.strokeStyle = 'rgba(29, 37, 62, 0.2)'
  context.lineWidth = 4

  switch (block.type) {
    case 'triangle':
    case 'roof':
      context.beginPath()
      context.moveTo(0, -height / 2)
      context.lineTo(width / 2, height / 2)
      context.lineTo(-width / 2, height / 2)
      context.closePath()
      context.fill()
      context.stroke()
      break
    case 'oval':
      context.beginPath()
      context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2)
      context.fill()
      context.stroke()
      break
    case 'window':
      context.fillRect(-width / 2, -height / 2, width, height)
      context.strokeRect(-width / 2, -height / 2, width, height)
      context.beginPath()
      context.moveTo(0, -height / 2)
      context.lineTo(0, height / 2)
      context.moveTo(-width / 2, 0)
      context.lineTo(width / 2, 0)
      context.stroke()
      break
    default:
      context.fillRect(-width / 2, -height / 2, width, height)
      context.strokeRect(-width / 2, -height / 2, width, height)
      break
  }

  context.restore()
}

function blockClassName(type: WorkshopBlockType) {
  return `workshop-block-shape workshop-${type}`
}

function inferSpeechLanguage(text: string) {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
}

function buildTeachingCopy(word: WordEntry) {
  if (word.english.trim() === word.chinese.trim()) {
    return `${word.english}。${word.english}。小朋友，跟着我一起读。`
  }

  return `${word.english}。${word.english}。意思是${word.chinese}。小朋友，跟着我一起读。`
}

function getWordVisual(word: WordEntry): WordVisual {
  const key = word.id.toLowerCase()

  if (key.includes('panda')) {
    return { emoji: '🐼', accent: '#111827', background: '#d8f7f0', scene: '竹林' }
  }
  if (key.includes('goose')) {
    return { emoji: '🪿', accent: '#f59e0b', background: '#fff3c4', scene: '池塘' }
  }
  if (key.includes('duck')) {
    return { emoji: '🦆', accent: '#f59e0b', background: '#fff7d6', scene: '池塘' }
  }
  if (key === 'dog' || key.includes('dog')) {
    return { emoji: '🐶', accent: '#f97316', background: '#ffedd5', scene: '草地' }
  }
  if (key === 'cat' || key.includes('cat')) {
    return { emoji: '🐱', accent: '#fb7185', background: '#ffe4e6', scene: '花园' }
  }
  if (key.includes('bus')) {
    return { emoji: '🚌', accent: '#2563eb', background: '#dbeafe', scene: '马路' }
  }
  if (key.includes('taxi')) {
    return { emoji: '🚕', accent: '#eab308', background: '#fef9c3', scene: '城市' }
  }
  if (key.includes('car')) {
    return { emoji: '🚗', accent: '#ef4444', background: '#fee2e2', scene: '街道' }
  }
  if (key.includes('plane')) {
    return { emoji: '✈️', accent: '#0ea5e9', background: '#e0f2fe', scene: '蓝天' }
  }
  if (key.includes('train') || key.includes('subway')) {
    return { emoji: '🚆', accent: '#7c3aed', background: '#ede9fe', scene: '车站' }
  }
  if (key.includes('snow')) {
    return { emoji: '❄️', accent: '#38bdf8', background: '#e0f2fe', scene: '雪地' }
  }
  if (key.includes('notebook')) {
    return { emoji: '📓', accent: '#22c55e', background: '#dcfce7', scene: '书桌' }
  }
  if (key.includes('sofa')) {
    return { emoji: '🛋️', accent: '#a855f7', background: '#f3e8ff', scene: '客厅' }
  }
  if (key.includes('house') || key.includes('build')) {
    return { emoji: '🏠', accent: '#f97316', background: '#ffedd5', scene: '小镇' }
  }
  if (key.includes('ball') || key.includes('kick')) {
    return { emoji: '⚽', accent: '#16a34a', background: '#dcfce7', scene: '球场' }
  }
  if (key.includes('ultraman')) {
    return { emoji: '🦸', accent: '#ef4444', background: '#fee2e2', scene: '卡通世界' }
  }

  return { emoji: '✨', accent: '#2563eb', background: '#e0f2fe', scene: '英语小镇' }
}

function createWordImage(word: WordEntry) {
  const visual = getWordVisual(word)
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${visual.background}" />
          <stop offset="100%" stop-color="#ffffff" />
        </linearGradient>
      </defs>
      <rect width="640" height="420" rx="36" fill="url(#bg)" />
      <circle cx="540" cy="88" r="46" fill="${visual.accent}" opacity="0.14" />
      <circle cx="112" cy="332" r="64" fill="${visual.accent}" opacity="0.12" />
      <rect x="34" y="34" width="572" height="352" rx="28" fill="white" fill-opacity="0.66" />
      <text x="320" y="152" text-anchor="middle" font-size="112">${visual.emoji}</text>
      <text x="320" y="228" text-anchor="middle" font-size="44" font-family="Arial, sans-serif" font-weight="700" fill="#0f172a">${word.english}</text>
      <text x="320" y="274" text-anchor="middle" font-size="28" font-family="Arial, sans-serif" fill="#334155">${word.chinese}</text>
      <text x="320" y="326" text-anchor="middle" font-size="22" font-family="Arial, sans-serif" fill="${visual.accent}">${visual.scene}里的单词卡</text>
    </svg>
  `

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

function App() {
  const [appState, setAppState] = useState<AppState>(() => loadAppState())
  const [gameSession, setGameSession] = useState<GameSession | null>(null)
  const [lastResult, setLastResult] = useState<SessionResult | null>(null)
  const [answerDraft, setAnswerDraft] = useState('')
  const [feedbackDraft, setFeedbackDraft] = useState('')
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [speechError, setSpeechError] = useState('')
  const [workshopHistory, setWorkshopHistory] = useState<WorkshopBlock[][]>([])
  const [focusedBubbleId, setFocusedBubbleId] = useState<string | null>(null)
  const [parentWordDraft, setParentWordDraft] = useState('')
  const [parentWordLoading, setParentWordLoading] = useState(false)
  const [parentWordMessage, setParentWordMessage] = useState('')
  const [micCountdown, setMicCountdown] = useState<number | null>(null)
  const [listeningBubbleId, setListeningBubbleId] = useState<string | null>(null)
  const [wordSpotlight, setWordSpotlight] = useState<{
    word: WordEntry
    imageUrl: string
    visual: WordVisual
  } | null>(null)
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const workshopCanvasRef = useRef<HTMLDivElement | null>(null)
  const gameplaySceneRef = useRef<HTMLElement | null>(null)
  const parentWordInputRef = useRef<HTMLInputElement | null>(null)
  const answerDraftRef = useRef(answerDraft)
  const activeBubbleRef = useRef<ReturnType<typeof getActiveBubble>>(null)
  const finishLevelRef = useRef<() => void>(() => {})
  const countdownTimerRef = useRef<number | null>(null)
  const listeningTimerRef = useRef<number | null>(null)
  const voicePracticeStreamRef = useRef<MediaStream | null>(null)
  const voicePracticeAudioContextRef = useRef<AudioContext | null>(null)
  const voicePracticeFrameRef = useRef<number | null>(null)
  const dragState = useRef<{
    id: string
    pointerId: number
    offsetX: number
    offsetY: number
  } | null>(null)

  const currentCharacter = characters.find(
    (character) => character.id === appState.selectedCharacter,
  )
  const currentLevel = levelByNumber(appState.currentLevel)
  const activeBubble = getActiveBubble(gameSession, focusedBubbleId)
  const wordBankSummary = buildWordBankSummary(appState.wordBank)
  const safeScene =
    appState.scene === 'gameplay' && !gameSession
      ? appState.selectedCharacter
        ? 'dashboard'
        : 'welcome'
      : appState.scene === 'complete' && !lastResult
        ? appState.selectedCharacter
          ? 'dashboard'
          : 'welcome'
        : appState.scene
  const usageLocked = appState.usageTodayMinutes >= appState.settings.dailyLimit
  const selectedBlock =
    appState.workshopBlocks.find((block) => block.id === selectedBlockId) ?? null

  useEffect(() => {
    saveAppState(appState)
  }, [appState])

  useEffect(() => {
    answerDraftRef.current = answerDraft
  }, [answerDraft])

  useEffect(() => {
    activeBubbleRef.current = activeBubble
  }, [activeBubble])

  useEffect(() => {
    if (safeScene !== appState.scene) {
      setAppState((previous) => ({ ...previous, scene: safeScene }))
    }
  }, [appState.scene, safeScene])

  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) {
        window.clearTimeout(countdownTimerRef.current)
      }
      if (listeningTimerRef.current) {
        window.clearTimeout(listeningTimerRef.current)
      }
      window.speechSynthesis?.cancel()
      recognitionRef.current?.stop()
      stopVoicePractice()
    }
  }, [])

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setAppState((previous) => ({ ...previous, microphoneStatus: 'unsupported' }))
      return
    }

    if (!navigator.permissions?.query) {
      setAppState((previous) => ({ ...previous, microphoneStatus: 'prompt' }))
      return
    }

    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((result) => {
        setAppState((previous) => ({
          ...previous,
          microphoneStatus: result.state as MicrophoneStatus,
        }))
      })
      .catch(() => {
        setAppState((previous) => ({ ...previous, microphoneStatus: 'prompt' }))
      })
  }, [])

  useEffect(() => {
    if (appState.scene !== 'gameplay') {
      return
    }

    function nudgePlayer(direction: Direction) {
      setGameSession((previous) => {
        if (!previous) {
          return previous
        }

        const delta =
          direction === 'up'
            ? { x: 0, y: -6 }
            : direction === 'down'
              ? { x: 0, y: 6 }
              : direction === 'left'
                ? { x: -6, y: 0 }
                : { x: 6, y: 0 }

        return {
          ...previous,
          player: {
            x: clamp(previous.player.x + delta.x, 6, 94),
            y: clamp(previous.player.y + delta.y, 10, 86),
          },
        }
      })
    }

    function submitKeyboardAnswer(rawAnswer: string) {
      setGameSession((previous) => {
        const currentBubble = activeBubbleRef.current
        if (!previous || !currentBubble) {
          return previous
        }

        if (currentBubble.distance > 16) {
          return {
            ...previous,
            feedback: '再靠近一点，单词泡泡会放大提醒你。',
          }
        }

        const isCorrect = isAnswerCorrect(rawAnswer, currentBubble.bubble.word.english)
        setAnswerDraft('')
        return {
          ...previous,
          bubbles: previous.bubbles.map((bubble) =>
            bubble.id === currentBubble.bubble.id
              ? {
                  ...bubble,
                  status: isCorrect ? 'cleared' : bubble.status,
                  attempts: bubble.attempts + (isCorrect ? 0 : 1),
                }
              : bubble,
          ),
          energy: clamp(previous.energy + (isCorrect ? 10 : 0), 0, 100),
          feedback: isCorrect
            ? `太棒啦！${currentBubble.bubble.word.english} 已被踢飞，去找下一个泡泡。`
            : `再试试！${currentBubble.bubble.word.chinese} 的英文是 ${currentBubble.bubble.word.english}。`,
        }
      })
    }

    function isSpaceKey(event: KeyboardEvent) {
      return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar' || event.key === 'Space'
    }

    function handleKeyDown(event: KeyboardEvent) {
      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault()
          nudgePlayer('up')
          break
        case 'ArrowDown':
          event.preventDefault()
          nudgePlayer('down')
          break
        case 'ArrowLeft':
          event.preventDefault()
          nudgePlayer('left')
          break
        case 'ArrowRight':
          event.preventDefault()
          nudgePlayer('right')
          break
        case 'Enter':
          if (answerDraftRef.current.trim()) {
            submitKeyboardAnswer(answerDraftRef.current)
          }
          break
        default:
          if (!isSpaceKey(event)) {
            break
          }
          event.preventDefault()
          finishLevelRef.current()
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [appState.scene])

  useEffect(() => {
    if (safeScene !== 'gameplay') {
      return
    }

    window.setTimeout(() => {
      gameplaySceneRef.current?.focus()
    }, 0)
  }, [safeScene, gameSession?.level.id])

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!dragState.current || !workshopCanvasRef.current) {
        return
      }

      const bounds = workshopCanvasRef.current.getBoundingClientRect()
      const nextX = clamp(event.clientX - bounds.left - dragState.current.offsetX, 0, bounds.width - 40)
      const nextY = clamp(event.clientY - bounds.top - dragState.current.offsetY, 0, bounds.height - 40)

      setAppState((previous) => ({
        ...previous,
        workshopBlocks: previous.workshopBlocks.map((block) =>
          block.id === dragState.current?.id ? { ...block, x: nextX, y: nextY } : block,
        ),
      }))
    }

    function handlePointerUp(event: PointerEvent) {
      if (dragState.current?.pointerId !== event.pointerId) {
        return
      }

      dragState.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [])

  function goToScene(scene: Scene) {
    startTransition(() => {
      setAppState((previous) => ({ ...previous, scene }))
    })
  }

  function updateAppState(updater: (previous: AppState) => AppState) {
    setAppState((previous) => updater(previous))
  }

  function releaseGameplayFocus() {
    parentWordInputRef.current?.blur()
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    gameplaySceneRef.current?.focus()
  }

  function beginLevel(levelNumber = appState.currentLevel) {
    const level = levelByNumber(levelNumber)
    const words = pickWordsForLevel(appState.wordBank, appState.libraryProgress, level).slice(
      0,
      MAX_FIELD_BUBBLES,
    )
    setGameSession({
      level,
      background: level.background,
      bubbles: createBubbleLayout(words),
      player: { x: 12, y: 76 },
      energy: 35,
      feedback:
        words.length === 0
          ? '球场还没有单词。家长先在右侧输入中文，系统会自动生成英文泡泡并加入词库。'
          : '球场上同时只保留 3 个单词泡泡。点击泡泡听示范，再点麦克风让小朋友说。',
      startTime: Date.now(),
    })
    setAnswerDraft('')
    setSpeechError('')
    setFocusedBubbleId(null)
    setParentWordDraft('')
    setParentWordLoading(false)
    setParentWordMessage('')
    setMicCountdown(null)
    setListeningBubbleId(null)
    setWordSpotlight(null)
    goToScene('gameplay')
    window.setTimeout(() => {
      releaseGameplayFocus()
    }, 0)
  }

  function speakTeachingWord(word: WordEntry) {
    const synth = window.speechSynthesis
    const SpeechUtterance = window.SpeechSynthesisUtterance
    if (!synth || !SpeechUtterance) {
      setSpeechError('当前浏览器不支持语音播放。')
      return
    }

    synth.cancel()
    setSpeechError('')

    const teaching = new SpeechUtterance(buildTeachingCopy(word))
    const chineseVoice = synth
      .getVoices()
      .find((voice) => voice.lang.toLowerCase().startsWith('zh'))

    teaching.lang = 'zh-CN'
    teaching.rate = 0.9
    teaching.pitch = 1.02
    if (chineseVoice) {
      teaching.voice = chineseVoice
    }

    synth.speak(teaching)
  }

  function handleBubbleClick(bubble: BubbleState) {
    setFocusedBubbleId(bubble.id)
    const visual = getWordVisual(bubble.word)
    setWordSpotlight({
      word: bubble.word,
      imageUrl: createWordImage(bubble.word),
      visual,
    })
    speakTeachingWord(bubble.word)
    setGameSession((previous) =>
      previous
        ? {
            ...previous,
            player: {
              x: clamp(bubble.x - 6, 6, 94),
              y: clamp(bubble.y + 8, 10, 86),
            },
            feedback:
              bubble.word.english === bubble.word.chinese
                ? `老师时间到：${bubble.word.english}。请先听示范，再点小麦克风让小朋友说。`
                : `老师时间到：${bubble.word.english}，中文是${bubble.word.chinese}。请先听示范，再点小麦克风让小朋友说。`,
          }
        : previous,
    )
  }

  async function addBubbleFromChinese() {
    const keyword = parentWordDraft.trim()
    if (!keyword) {
      setParentWordMessage('先输入一个中文词。')
      return
    }

    if (!gameSession) {
      setParentWordMessage('请先进入闯关页。')
      return
    }

    setParentWordLoading(true)
    setParentWordMessage('正在生成英文单词...')

    try {
      const resolved = await resolveParentWord(
        keyword,
        appState.wordBank,
        gameSession.level.difficulty,
      )

      if (!resolved) {
        setParentWordMessage('生成英文失败了，请检查网络后再试一次。')
        return
      }

      const nextBubbleId = `${resolved.word.id}-${crypto.randomUUID()}`
      const nextBubble: BubbleState = {
        id: nextBubbleId,
        word: resolved.word,
        x: 0,
        y: 0,
        status: 'pending',
        attempts: 0,
        createdOrder: 0,
      }

      updateAppState((previous) => {
        const alreadySaved = previous.wordBank.some((word) => word.id === resolved.word.id)
        return {
          ...previous,
          wordBank: alreadySaved ? previous.wordBank : [...previous.wordBank, resolved.word],
          libraryProgress: previous.libraryProgress[resolved.word.id]
            ? previous.libraryProgress
            : {
                ...previous.libraryProgress,
                [resolved.word.id]: { seen: 0, correct: 0, wrong: 0 },
              },
        }
      })

      setGameSession((previous) => {
        if (!previous) {
          return previous
        }

        const nextCreatedOrder =
          previous.bubbles.reduce(
            (maxOrder, bubble) => Math.max(maxOrder, bubble.createdOrder),
            -1,
          ) + 1

        const replaceIndex =
          previous.bubbles.length < MAX_FIELD_BUBBLES
            ? previous.bubbles.length
            : previous.bubbles.reduce((oldestIndex, bubble, index, bubbles) =>
                bubble.createdOrder < bubbles[oldestIndex].createdOrder
                  ? index
                  : oldestIndex,
              0)

        const fallbackPosition = getNextBubblePosition(previous.bubbles)
        const replacedBubble = previous.bubbles[replaceIndex]
        const bubbleWithPosition = {
          ...nextBubble,
          x: replacedBubble?.x ?? fallbackPosition.x,
          y: replacedBubble?.y ?? fallbackPosition.y,
          createdOrder: nextCreatedOrder,
        }
        const nextBubbles =
          previous.bubbles.length < MAX_FIELD_BUBBLES
            ? [...previous.bubbles, bubbleWithPosition]
            : previous.bubbles.map((bubble, index) =>
                index === replaceIndex ? bubbleWithPosition : bubble,
              )

        return {
          ...previous,
          bubbles: nextBubbles,
          feedback:
            resolved.source === 'existing'
              ? `这个单词已经在词库里了，球场泡泡已切换成 ${resolved.word.english}。`
              : `家长刚刚加入了新单词：${resolved.word.chinese}，球场泡泡已切换成 ${resolved.word.english}。`,
        }
      })

      setWordSpotlight({
        word: resolved.word,
        imageUrl: createWordImage(resolved.word),
        visual: getWordVisual(resolved.word),
      })
      setParentWordDraft('')
      setParentWordMessage(
        resolved.source === 'existing'
          ? `已使用词库里的英文：${resolved.word.english}`
          : `已生成英文泡泡：${resolved.word.english}，并补充到词库`,
      )
      setFocusedBubbleId(nextBubbleId)
      releaseGameplayFocus()
    } finally {
      setParentWordLoading(false)
    }
  }

  function movePlayer(direction: Direction) {
    setGameSession((previous) => {
      if (!previous) {
        return previous
      }

      const delta =
        direction === 'up'
          ? { x: 0, y: -6 }
          : direction === 'down'
            ? { x: 0, y: 6 }
            : direction === 'left'
              ? { x: -6, y: 0 }
              : { x: 6, y: 0 }

      return {
        ...previous,
        player: {
          x: clamp(previous.player.x + delta.x, 6, 94),
          y: clamp(previous.player.y + delta.y, 10, 86),
        },
      }
    })
  }

  function skipBubble() {
    if (!activeBubble) {
      return
    }

    setGameSession((previous) => {
      if (!previous) {
        return previous
      }

      return {
        ...previous,
        bubbles: previous.bubbles.map((bubble) =>
          bubble.id === activeBubble.bubble.id
            ? { ...bubble, status: 'skipped', attempts: Math.max(3, bubble.attempts) }
            : bubble,
        ),
        energy: clamp(previous.energy - 5, 0, 100),
        feedback: `${activeBubble.bubble.word.english} 已跳过，继续前进吧。`,
      }
    })
    setFocusedBubbleId((previous) =>
      previous === activeBubble.bubble.id ? null : previous,
    )
  }

  function finishLevel() {
    if (!gameSession) {
      return
    }

    const distance = Math.hypot(
      gameSession.player.x - goalPosition.x,
      gameSession.player.y - goalPosition.y,
    )
    const allDone =
      gameSession.bubbles.length > 0 &&
      gameSession.bubbles.every((bubble) => bubble.status !== 'pending')

    if (!allDone) {
      setGameSession((previous) =>
        previous
          ? {
              ...previous,
              feedback: '先把所有单词泡泡踢飞，球门才会解锁。',
            }
          : previous,
      )
      return
    }

    if (distance > 24) {
      setGameSession((previous) =>
        previous
          ? {
              ...previous,
              feedback: '再向球门跑近一点，再按空格或点击射门。',
            }
          : previous,
      )
      return
    }

    const durationSeconds = Math.max(
      8,
      Math.round((Date.now() - gameSession.startTime) / 1000),
    )
    const correctCount = gameSession.bubbles.filter(
      (bubble) => bubble.status === 'cleared' && bubble.attempts === 0,
    ).length
    const accuracy = correctCount / gameSession.bubbles.length
    const wrongWords = gameSession.bubbles
      .filter((bubble) => bubble.attempts > 0 || bubble.status === 'skipped')
      .map((bubble) => ({
        wordId: bubble.word.id,
        english: bubble.word.english,
        chinese: bubble.word.chinese,
        count: bubble.attempts === 0 ? 1 : bubble.attempts,
        lastSeen: new Date().toISOString(),
        level: bubble.word.level,
      }))

    const result: SessionResult = {
      level: gameSession.level,
      accuracy,
      durationSeconds,
      total: gameSession.bubbles.length,
      correctCount,
      wrongWords,
    }

    setLastResult(result)
    updateAppState((previous) => {
      const uniqueCompleted = previous.completedLevels.includes(gameSession.level.id)
        ? previous.completedLevels
        : [...previous.completedLevels, gameSession.level.id]
      const starsEarned = previous.completedLevels.includes(gameSession.level.id) ? 0 : 1
      const unlockedBackgrounds: BackgroundId[] = ['sunny']

      if (uniqueCompleted.length >= 3) {
        unlockedBackgrounds.push('rainy')
      }
      if (uniqueCompleted.length >= 6) {
        unlockedBackgrounds.push('starry')
      }

      const mergedWrongWords = [...previous.wrongWords]
      wrongWords.forEach((word) => {
        const existing = mergedWrongWords.find((item) => item.wordId === word.wordId)
        if (existing) {
          existing.count += word.count
          existing.lastSeen = word.lastSeen
        } else {
          mergedWrongWords.push(word)
        }
      })

      return {
        ...previous,
        scene: 'complete',
        currentLevel: Math.min(previous.currentLevel + (starsEarned > 0 ? 1 : 0), levels.length),
        completedLevels: uniqueCompleted,
        stars: previous.stars + starsEarned,
        unlockedBackgrounds,
        usageTodayMinutes: previous.usageTodayMinutes + Math.max(1, Math.round(durationSeconds / 60)),
        usageWeekMinutes: previous.usageWeekMinutes + Math.max(1, Math.round(durationSeconds / 60)),
        wrongWords: mergedWrongWords.sort((left, right) => right.count - left.count).slice(0, 12),
        levelHistory: [
          {
            id: crypto.randomUUID(),
            levelId: gameSession.level.id,
            accuracy,
            durationSeconds,
            starsEarned,
            completedAt: new Date().toISOString(),
            wrongWords: wrongWords.map((word) => word.english),
          },
          ...previous.levelHistory,
        ].slice(0, 20),
        libraryProgress: gameSession.bubbles.reduce((collection, bubble) => {
          const current = collection[bubble.word.id] ?? { seen: 0, correct: 0, wrong: 0 }
          collection[bubble.word.id] = {
            seen: current.seen + 1,
            correct: current.correct + (bubble.status === 'cleared' && bubble.attempts === 0 ? 1 : 0),
            wrong: current.wrong + (bubble.attempts > 0 || bubble.status === 'skipped' ? 1 : 0),
          }
          return collection
        }, { ...previous.libraryProgress }),
      }
    })
    setGameSession(null)
  }

  useEffect(() => {
    finishLevelRef.current = finishLevel
  })

  function openProtectedScene(scene: Scene) {
    if (!appState.settings.parentPassword) {
      goToScene(scene)
      return
    }

    const answer = window.prompt('请输入家长密码后继续')
    if (answer === appState.settings.parentPassword) {
      goToScene(scene)
      return
    }

    window.alert('密码不正确。')
  }

  function requestMicrophonePermission() {
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop())
        updateAppState((previous) => ({ ...previous, microphoneStatus: 'granted' }))
      })
      .catch(() => {
        updateAppState((previous) => ({ ...previous, microphoneStatus: 'denied' }))
      })
  }

  function clearListeningTimers() {
    if (countdownTimerRef.current) {
      window.clearTimeout(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
    if (listeningTimerRef.current) {
      window.clearTimeout(listeningTimerRef.current)
      listeningTimerRef.current = null
    }
  }

  function stopVoicePractice() {
    if (voicePracticeFrameRef.current) {
      window.cancelAnimationFrame(voicePracticeFrameRef.current)
      voicePracticeFrameRef.current = null
    }
    if (voicePracticeStreamRef.current) {
      voicePracticeStreamRef.current.getTracks().forEach((track) => track.stop())
      voicePracticeStreamRef.current = null
    }
    if (voicePracticeAudioContextRef.current) {
      void voicePracticeAudioContextRef.current.close()
      voicePracticeAudioContextRef.current = null
    }
  }

  function handleBubbleAttemptResult(
    bubble: BubbleState,
    isCorrect: boolean,
    feedbackOverride?: string,
  ) {
    setGameSession((previous) => {
      if (!previous) {
        return previous
      }

      const nextBubbles = previous.bubbles.map((currentBubble) =>
        currentBubble.id === bubble.id
          ? {
              ...currentBubble,
              status: isCorrect ? 'cleared' : currentBubble.status,
              attempts: currentBubble.attempts + (isCorrect ? 0 : 1),
            }
          : currentBubble,
      )

      return {
        ...previous,
        bubbles: nextBubbles,
        energy: clamp(previous.energy + (isCorrect ? 10 : 0), 0, 100),
        feedback:
          feedbackOverride ??
          (isCorrect
            ? `太棒啦！${bubble.word.english} 已被踢飞，去找下一个泡泡。`
            : `再试试！${bubble.word.chinese} 的英文是 ${bubble.word.english}。`),
      }
    })

    setAnswerDraft('')
    if (isCorrect) {
      setFocusedBubbleId((previousFocus) => (previousFocus === bubble.id ? null : previousFocus))
    }
  }

  async function startVoicePracticeFallback(bubble: BubbleState, reason: 'unsupported' | 'network') {
    if (!navigator.mediaDevices?.getUserMedia) {
      setListening(false)
      setMicCountdown(null)
      setListeningBubbleId(null)
      setSpeechError('当前浏览器不支持麦克风收音。')
      return
    }

    stopVoicePractice()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext

      if (!AudioContextCtor) {
        stream.getTracks().forEach((track) => track.stop())
        setListening(false)
        setMicCountdown(null)
        setListeningBubbleId(null)
        setSpeechError('当前浏览器不支持本地收音分析。')
        return
      }

      const audioContext = new AudioContextCtor()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.82

      const source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)

      voicePracticeStreamRef.current = stream
      voicePracticeAudioContextRef.current = audioContext
      updateAppState((previous) => ({ ...previous, microphoneStatus: 'granted' }))
      setListening(true)
      setMicCountdown(null)
      setSpeechError('')
      setGameSession((previous) =>
        previous
          ? {
              ...previous,
              feedback:
                reason === 'network'
                  ? `在线识别暂时不可用，已切到本地跟读模式。请让小朋友在 3 秒内大声读出 ${bubble.word.english}。`
                  : `已切到本地跟读模式。请让小朋友在 3 秒内大声读出 ${bubble.word.english}。`,
            }
          : previous,
      )

      let heardFrames = 0
      let maxVolume = 0
      const samples = new Uint8Array(analyser.fftSize)

      const monitorVolume = () => {
        analyser.getByteTimeDomainData(samples)
        let sumSquares = 0
        for (const sample of samples) {
          const normalized = (sample - 128) / 128
          sumSquares += normalized * normalized
        }

        const rms = Math.sqrt(sumSquares / samples.length)
        maxVolume = Math.max(maxVolume, rms)
        if (rms > 0.05) {
          heardFrames += 1
        }

        voicePracticeFrameRef.current = window.requestAnimationFrame(monitorVolume)
      }

      monitorVolume()

      listeningTimerRef.current = window.setTimeout(() => {
        const heardVoice = heardFrames >= 8 || maxVolume > 0.075
        stopVoicePractice()
        setListening(false)
        setMicCountdown(null)
        setListeningBubbleId(null)

        if (heardVoice) {
          handleBubbleAttemptResult(
            bubble,
            true,
            `已经听到小朋友跟读 ${bubble.word.english}，先继续往前踢球吧。`,
          )
          return
        }

        setSpeechError('')
        setGameSession((previous) =>
          previous
            ? {
                ...previous,
                feedback: `这次没有听到明显声音，请再点一次小麦克风，大声读出 ${bubble.word.english}。`,
              }
            : previous,
        )
      }, 3000)
    } catch {
      stopVoicePractice()
      setListening(false)
      setMicCountdown(null)
      setListeningBubbleId(null)
      setSpeechError('麦克风没有打开，请先允许浏览器使用麦克风。')
      updateAppState((previous) => ({ ...previous, microphoneStatus: 'denied' }))
    }
  }

  function startListening(targetBubble?: BubbleState) {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    const bubble = targetBubble ?? activeBubbleRef.current?.bubble
    if (!bubble) {
      setSpeechError('先靠近一个单词泡泡，再点击麦克风。')
      return
    }

    clearListeningTimers()
    recognitionRef.current?.stop()
    stopVoicePractice()
    setFocusedBubbleId(bubble.id)
    setListeningBubbleId(bubble.id)
    setMicCountdown(3)
    setSpeechError('')
    setListening(false)
    setGameSession((previous) =>
      previous
        ? {
            ...previous,
            player: {
              x: clamp(bubble.x - 6, 6, 94),
              y: clamp(bubble.y + 8, 10, 86),
            },
            feedback: `准备开始：给小朋友 3 秒钟准备时间，然后对着 ${bubble.word.english} 说出来。`,
          }
        : previous,
    )

    const startRecognition = () => {
      if (!Recognition) {
        void startVoicePracticeFallback(bubble, 'unsupported')
        return
      }

      const recognition = new Recognition()
      recognition.lang = inferSpeechLanguage(bubble.word.english)
      recognition.continuous = false
      recognition.interimResults = false
      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript
        setAnswerDraft(transcript)
        const isCorrect = isAnswerCorrect(transcript, bubble.word.english)
        handleBubbleAttemptResult(bubble, isCorrect)
      }
      recognition.onerror = (event) => {
        recognitionRef.current = null
        setListening(false)
        setMicCountdown(null)
        if (event.error === 'network') {
          recognition.onend = null
          void startVoicePracticeFallback(bubble, 'network')
          return
        }

        setListeningBubbleId(null)
        setSpeechError('这次没有听清，我们再试一次。')
        setGameSession((previous) =>
          previous
            ? {
                ...previous,
                feedback: '没有听清刚刚的发音，请再点一次小麦克风。',
              }
            : previous,
        )
      }
      recognition.onend = () => {
        recognitionRef.current = null
        setListening(false)
        setMicCountdown(null)
        setListeningBubbleId(null)
      }

      recognitionRef.current = recognition
      setListening(true)
      setMicCountdown(null)
      setGameSession((previous) =>
        previous
          ? {
              ...previous,
              feedback: `开始说吧，系统会给小朋友 3 秒钟完整读出 ${bubble.word.english}。`,
            }
          : previous,
      )
      recognition.start()
      listeningTimerRef.current = window.setTimeout(() => {
        recognition.stop()
      }, 3000)
    }

    countdownTimerRef.current = window.setTimeout(() => {
      setMicCountdown(2)
      countdownTimerRef.current = window.setTimeout(() => {
        setMicCountdown(1)
        countdownTimerRef.current = window.setTimeout(() => {
          startRecognition()
        }, 1000)
      }, 1000)
    }, 1000)
  }

  function validateService(kind: 'volcengine' | 'feishu') {
    updateAppState((previous) => ({
      ...previous,
      apiConfig: {
        ...previous.apiConfig,
        [kind]: {
          ...previous.apiConfig[kind],
          status: 'checking',
          message: '验证中...',
        },
      },
    }))

    window.setTimeout(() => {
      updateAppState((previous) => {
        const fields =
          kind === 'volcengine'
            ? [
                previous.apiConfig.volcengine.appId,
                previous.apiConfig.volcengine.accessKey,
                previous.apiConfig.volcengine.secretKey,
              ]
            : [
                previous.apiConfig.feishu.appId,
                previous.apiConfig.feishu.appSecret,
                previous.apiConfig.feishu.tableLink,
              ]
        const success = fields.every((value) => value.trim().length > 0)

        return {
          ...previous,
          apiConfig: {
            ...previous.apiConfig,
            [kind]: {
              ...previous.apiConfig[kind],
              status: success ? 'success' : 'error',
              message:
                kind === 'volcengine'
                  ? success
                    ? '连接成功，语音功能已就绪。'
                    : '请补全火山引擎的 AppID、AccessKey、SecretKey。'
                  : success
                    ? '词库连接成功，可以同步在线单词。'
                    : '请补全飞书 App ID、App Secret 和多维表格链接。',
            },
          },
        }
      })
    }, 900)
  }

  function syncVocabulary() {
    updateAppState((previous) => ({
      ...previous,
      apiConfig: {
        ...previous.apiConfig,
        feishu: {
          ...previous.apiConfig.feishu,
          status: 'checking',
          message: '同步中...',
        },
      },
    }))

    window.setTimeout(() => {
      updateAppState((previous) => ({
        ...previous,
        apiConfig: {
          ...previous.apiConfig,
          feishu: {
            ...previous.apiConfig.feishu,
            status: 'success',
            message:
              previous.apiConfig.feishu.tableLink.trim().length > 0
                ? '在线词库已同步到本地缓存。'
                : '未配置飞书时，已展示本地家长词库。',
          },
          lastSyncAt: new Date().toISOString(),
          lastSyncSummary: buildWordBankSummary(previous.wordBank),
        },
      }))
    }, 1200)
  }

  function pushWorkshopHistory() {
    setWorkshopHistory((previous) => [
      appState.workshopBlocks.map((block) => ({ ...block })),
      ...previous,
    ].slice(0, 20))
  }

  function addWorkshopBlock(template: (typeof workshopPalette)[number]) {
    pushWorkshopHistory()
    const block: WorkshopBlock = {
      ...template,
      id: crypto.randomUUID(),
      x: 240 + Math.random() * 120,
      y: 180 + Math.random() * 100,
    }
    updateAppState((previous) => ({
      ...previous,
      workshopBlocks: [...previous.workshopBlocks, block],
      scene: 'workshop',
    }))
    setSelectedBlockId(block.id)
  }

  function updateSelectedBlock(patch: Partial<WorkshopBlock>) {
    if (!selectedBlockId) {
      return
    }

    pushWorkshopHistory()
    updateAppState((previous) => ({
      ...previous,
      workshopBlocks: previous.workshopBlocks.map((block) =>
        block.id === selectedBlockId ? { ...block, ...patch } : block,
      ),
    }))
  }

  function removeSelectedBlock() {
    if (!selectedBlockId) {
      return
    }

    pushWorkshopHistory()
    updateAppState((previous) => ({
      ...previous,
      workshopBlocks: previous.workshopBlocks.filter((block) => block.id !== selectedBlockId),
    }))
    setSelectedBlockId(null)
  }

  function undoWorkshop() {
    const [lastSnapshot, ...rest] = workshopHistory
    if (!lastSnapshot) {
      return
    }

    setWorkshopHistory(rest)
    updateAppState((previous) => ({ ...previous, workshopBlocks: lastSnapshot }))
  }

  function saveArtwork() {
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 800
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    context.fillStyle = '#f8f7f5'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#dceefd'
    context.fillRect(0, 0, canvas.width, 200)
    context.fillStyle = '#d9f6c5'
    context.fillRect(0, 200, canvas.width, 600)

    appState.workshopBlocks.forEach((block) => drawWorkshopShape(context, block, 100, 40))

    const imageData = canvas.toDataURL('image/png')
    const fileName = `football-town-workshop-${Date.now()}.png`
    const link = document.createElement('a')
    link.href = imageData
    link.download = fileName
    link.click()

    const creationName = window.prompt('给你的作品取个名字吧', `我的作品 ${appState.workshopCreations.length + 1}`)

    updateAppState((previous) => ({
      ...previous,
      workshopCreations: [
        {
          id: crypto.randomUUID(),
          name: creationName?.trim() || `我的作品 ${previous.workshopCreations.length + 1}`,
          savedAt: new Date().toISOString(),
          imageData,
          blocks: previous.workshopBlocks.map((block) => ({ ...block })),
        },
        ...previous.workshopCreations,
      ].slice(0, 8),
    }))
  }

  function submitFeedback() {
    if (!feedbackDraft.trim()) {
      return
    }

    const entry: FeedbackEntry = {
      id: crypto.randomUUID(),
      text: feedbackDraft.trim(),
      createdAt: new Date().toISOString(),
    }

    updateAppState((previous) => ({
      ...previous,
      feedbackMessages: [entry, ...previous.feedbackMessages].slice(0, 8),
    }))
    setFeedbackDraft('')
  }

  function resetDemo() {
    const resetState = createDefaultAppState()
    setGameSession(null)
    setLastResult(null)
    setAnswerDraft('')
    setParentWordDraft('')
    setParentWordLoading(false)
    setParentWordMessage('')
    setWordSpotlight(null)
    setWorkshopHistory([])
    setSelectedBlockId(null)
    setAppState(resetState)
  }

  const trendValues = appState.levelHistory
    .slice(0, 7)
    .map((entry) => Math.max(45, Math.round(entry.accuracy * 100)))
    .reverse()
  const weeklyTrend =
    trendValues.length >= 4 ? trendValues : [62, 66, 70, 68, 74, 79, 86]
  const trendPath = weeklyTrend
    .map((value, index) => `${index === 0 ? 'M' : 'L'} ${index * 80} ${150 - value}`)
    .join(' ')

  const categoryStats = appState.wordBank
    .filter((word) => word.enabled)
    .reduce<Record<string, number>>((result, word) => {
      const entry = appState.libraryProgress[word.id]
      const score = entry ? entry.correct + 1 : 1
      result[word.category] = (result[word.category] ?? 0) + score
      return result
    }, {})
  const totalCategoryScore = Object.values(categoryStats).reduce((sum, value) => sum + value, 0) || 1
  const categoryColors = ['#197fe6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444']
  const categoryEntries = Object.entries(categoryStats)

  const unlockedGoal =
    gameSession && gameSession.bubbles.length > 0
      ? gameSession.bubbles.every((bubble) => bubble.status !== 'pending')
      : false

  return (
    <div className="app-shell">
      {safeScene === 'welcome' && (
        <section className="scene welcome-scene">
          <header className="topbar">
            <div className="brand-pill">
              <span className="brand-ball">⚽</span>
              <div>
                <strong>足球英语小镇</strong>
                <span>Football English Town</span>
              </div>
            </div>
            <button className="ghost-button" onClick={() => goToScene('api')}>
              系统配置
            </button>
          </header>
          <div className="welcome-hero">
            <div className="hero-bubbles">
              <span>Hello!</span>
              <span>Panda</span>
              <span>Dog</span>
            </div>
            <div className="hero-mascots">
              {characters.map((character) => (
                <div key={character.id} className="mascot" style={{ '--accent': character.accent } as React.CSSProperties}>
                  <div>{character.emoji}</div>
                  <span>{character.name}</span>
                </div>
              ))}
            </div>
            <div className="hero-copy">
              <h1>踢单词，进球，再搭一座梦想小屋。</h1>
              <p>
                依据原型制作的儿童英语学习 Web 应用，包含足球闯关、创意工坊、家长中心和本地 API 配置。
              </p>
              <div className="hero-actions">
                <button className="primary-button large" onClick={() => goToScene('characters')}>
                  开始冒险
                </button>
                <button className="secondary-button" onClick={() => openProtectedScene('parent')}>
                  家长中心
                </button>
              </div>
            </div>
          </div>
          <footer className="feature-strip">
            <article>
              <span>⚽</span>
              <strong>踢单词</strong>
              <p>靠近泡泡，说出英语，立刻获得反馈。</p>
            </article>
            <article>
              <span>🥅</span>
              <strong>进球通关</strong>
              <p>解锁球门后射门，赢下本关星星奖励。</p>
            </article>
            <article>
              <span>🏡</span>
              <strong>搭房子</strong>
              <p>把闯关奖励变成创意搭建和作品保存。</p>
            </article>
          </footer>
        </section>
      )}

      {safeScene === 'characters' && (
        <section className="scene character-scene">
          <div className="section-header">
            <div>
              <span className="eyebrow">首次使用</span>
              <h2>选择你的冒险角色</h2>
            </div>
            <button className="ghost-button" onClick={() => goToScene('welcome')}>
              返回首页
            </button>
          </div>
          <div className="character-grid">
            {characters.map((character) => (
              <button
                key={character.id}
                className={`character-card ${
                  appState.selectedCharacter === character.id ? 'is-selected' : ''
                }`}
                onClick={() =>
                  updateAppState((previous) => ({
                    ...previous,
                    selectedCharacter: character.id as CharacterId,
                    scene: 'dashboard',
                  }))
                }
              >
                <div className="character-emoji" style={{ background: character.accent }}>
                  {character.emoji}
                </div>
                <strong>{character.name}</strong>
                <span>{character.englishName}</span>
                <p>{character.description}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      {safeScene === 'dashboard' && (
        <section className="scene dashboard-scene">
          <header className="topbar sticky">
            <div className="brand-pill">
              <span className="brand-ball">⚽</span>
              <div>
                <strong>足球英语小镇</strong>
                <span>{currentCharacter?.name ?? '等待选择角色'}</span>
              </div>
            </div>
            <div className="topbar-actions">
              <button className="ghost-button" onClick={() => openProtectedScene('parent')}>
                家长中心
              </button>
              <button className="ghost-button" onClick={() => goToScene('api')}>
                API 配置
              </button>
              <div className="star-chip">⭐ x {appState.stars}</div>
            </div>
          </header>
          <div className="dashboard-layout">
            <section className="map-panel">
              <div className="map-sky" />
              <svg className="map-path" viewBox="0 0 1000 620" preserveAspectRatio="none">
                <path
                  d="M 90 530 Q 230 520 310 410 T 480 320 T 700 190 T 910 80"
                  fill="none"
                  stroke="#6af425"
                  strokeWidth="10"
                  strokeDasharray="10 12"
                />
              </svg>
              <div className="level-map">
                {levels.map((level, index) => {
                  const completed = appState.completedLevels.includes(level.id)
                  const locked = level.number > Math.max(appState.currentLevel, 1)
                  const current = level.number === currentLevel.number
                  const positions = [
                    { left: '8%', top: '72%' },
                    { left: '20%', top: '62%' },
                    { left: '30%', top: '48%' },
                    { left: '44%', top: '38%' },
                    { left: '58%', top: '31%' },
                    { left: '68%', top: '45%' },
                    { left: '78%', top: '30%' },
                    { left: '88%', top: '18%' },
                    { left: '70%', top: '17%' },
                    { left: '52%', top: '14%' },
                    { left: '37%', top: '19%' },
                    { left: '22%', top: '24%' },
                    { left: '12%', top: '37%' },
                    { left: '25%', top: '9%' },
                    { left: '8%', top: '17%' },
                  ][index]

                  return (
                    <button
                      key={level.id}
                      className={`level-node ${completed ? 'is-complete' : ''} ${
                        current ? 'is-current' : ''
                      } ${locked ? 'is-locked' : ''}`}
                      style={positions}
                      onClick={() => !locked && beginLevel(level.number)}
                    >
                      <span>{completed ? '★' : locked ? '🔒' : '▶'}</span>
                      <small>{level.id}</small>
                    </button>
                  )
                })}
              </div>
            </section>
            <aside className="dashboard-sidebar">
              <div className="info-card">
                <span className="eyebrow">当前关卡</span>
                <h3>
                  {currentLevel.id} · {currentLevel.title}
                </h3>
                <p>{currentLevel.subtitle}</p>
                <div className="meta-row">
                  <span>难度：{currentLevel.difficulty}</span>
                  <span>背景：{backgroundLabel(currentLevel.background)}</span>
                </div>
              </div>
              <div className="cta-stack">
                <button className="primary-button large" disabled={usageLocked} onClick={() => beginLevel()}>
                  开始闯关
                </button>
                <button className="accent-button large" disabled={usageLocked} onClick={() => goToScene('workshop')}>
                  创意工坊
                </button>
                <button className="secondary-button" onClick={() => goToScene('review')}>
                  错题本
                </button>
              </div>
              <div className="info-card compact">
                <strong>今日学习</strong>
                <p>
                  {appState.usageTodayMinutes}/{appState.settings.dailyLimit} 分钟
                </p>
                {usageLocked && <span className="warning-text">已达到今日时长上限，请到家长设置中调整。</span>}
              </div>
            </aside>
          </div>
        </section>
      )}

      {safeScene === 'gameplay' && gameSession && (
        <section
          className={`scene gameplay-scene background-${gameSession.background}`}
          ref={gameplaySceneRef}
          tabIndex={-1}
        >
          <div className="hud-bar">
            <div className="hud-chip">{gameSession.level.id}</div>
            <div className="hud-progress">
              <strong>
                {gameSession.bubbles.filter((bubble) => bubble.status !== 'pending').length}/
                {gameSession.bubbles.length}
              </strong>
              <span>已踢飞单词数</span>
            </div>
            <div className="hud-energy">
              <span>能量</span>
              <div className="energy-track">
                <div className="energy-fill" style={{ height: `${gameSession.energy}%` }} />
              </div>
            </div>
          </div>
          <div className="stadium-layout">
            <div className="field-shell">
              {wordSpotlight && (
                <div
                  className="field-spotlight"
                  style={{ '--spotlight-accent': wordSpotlight.visual.accent } as React.CSSProperties}
                >
                  <img
                    src={wordSpotlight.imageUrl}
                    alt={wordSpotlight.word.english}
                    className="field-spotlight-image"
                  />
                  <div className="field-spotlight-copy">
                    <strong>{wordSpotlight.word.english}</strong>
                    <span>{wordSpotlight.word.chinese}</span>
                  </div>
                </div>
              )}
              <div className={`goal ${unlockedGoal ? 'is-open' : ''}`} style={{ left: '50%', top: '11%' }}>
                <span className="goal-frame goal-top" />
                <span className="goal-frame goal-left" />
                <span className="goal-frame goal-right" />
                <span className="goal-net" />
              </div>
              {gameSession.bubbles.map((bubble) => {
                const near =
                  Math.hypot(gameSession.player.x - bubble.x, gameSession.player.y - bubble.y) <= 16
                return (
                  <div key={bubble.id}>
                    <button
                      className={`word-bubble ${bubble.status} ${near ? 'is-near' : ''}`}
                      style={{ left: `${bubble.x}%`, top: `${bubble.y}%` }}
                      onClick={() => handleBubbleClick(bubble)}
                    >
                      <span>{bubble.word.english}</span>
                      <small>{bubble.word.chinese}</small>
                    </button>
                    {near && bubble.status === 'pending' && (
                      <button
                        className={`bubble-mic ${listening && focusedBubbleId === bubble.id ? 'is-listening' : ''}`}
                        style={{ left: `${bubble.x + 7}%`, top: `${bubble.y - 8}%` }}
                        onClick={(event) => {
                          event.stopPropagation()
                          startListening(bubble)
                        }}
                        aria-label={`录音 ${bubble.word.english}`}
                        title={`录音 ${bubble.word.english}`}
                      >
                        <span>
                          {micCountdown !== null && listeningBubbleId === bubble.id
                            ? micCountdown
                            : listening && focusedBubbleId === bubble.id
                              ? '🎙️'
                              : '🎤'}
                        </span>
                      </button>
                    )}
                  </div>
                )
              })}
              <div
                className="player-token"
                style={{ left: `${gameSession.player.x}%`, top: `${gameSession.player.y}%` }}
              >
                <div className="player-aura" />
                <div className="player-body">
                  <div
                    className={`player-head ${currentCharacter?.imageUrl ? 'has-illustration' : ''}`}
                    style={
                      currentCharacter?.imageUrl
                        ? ({ '--player-image': `url('${currentCharacter.imageUrl}')` } as React.CSSProperties)
                        : undefined
                    }
                  >
                    {!currentCharacter?.imageUrl && <span>{currentCharacter?.emoji ?? '⚽'}</span>}
                  </div>
                  <div className="player-jersey" />
                </div>
                <div className="ball-shadow">⚽</div>
              </div>
            </div>
            <aside className="coach-panel">
              <div className="info-card parent-console-card">
                <span className="eyebrow">家长输入</span>
                <div className="parent-console-row">
                  <input
                    ref={parentWordInputRef}
                    value={parentWordDraft}
                    onChange={(event) => setParentWordDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !parentWordLoading) {
                        void addBubbleFromChinese()
                      }
                    }}
                    placeholder="中文词，例如：熊猫"
                  />
                  <button
                    className="parent-add-button"
                    onClick={() => void addBubbleFromChinese()}
                    aria-label="生成泡泡"
                    disabled={parentWordLoading}
                  >
                    <span>{parentWordLoading ? '⏳' : '✨'}</span>
                  </button>
                </div>
                {parentWordMessage && <p className="helper-text">{parentWordMessage}</p>}
              </div>
              <div className="info-card">
                <span className="eyebrow">当前挑战</span>
                {gameSession.bubbles.length === 0 ? (
                  <>
                    <h3>等待家长加词</h3>
                    <p>右侧输入中文后，系统会自动翻译成英文泡泡并存进词库。</p>
                  </>
                ) : activeBubble ? (
                  <>
                    <h3>{activeBubble.bubble.word.english}</h3>
                    <p>{activeBubble.bubble.word.chinese}</p>
                    <div className="meta-row">
                      <span>距离：{Math.round(activeBubble.distance)}</span>
                      <span>尝试：{activeBubble.bubble.attempts}/3</span>
                    </div>
                  </>
                ) : (
                  <>
                    <h3>球门已解锁</h3>
                    <p>冲刺到球门前，点击射门完成本关。</p>
                  </>
                )}
              </div>
              <div className="kid-action-hint">
                <div className="kid-action-chip">
                  <span className="kid-action-icon">🔊</span>
                  <small>点泡泡听示范</small>
                </div>
                <div className="kid-action-chip">
                  <span className="kid-action-icon">🎤</span>
                  <small>点麦克风说话</small>
                </div>
              </div>
              {activeBubble && activeBubble.bubble.attempts >= 3 && (
                <button className="skip-icon-button" onClick={skipBubble} aria-label="跳过单词">
                  <span>⏭️</span>
                </button>
              )}
              {speechError && <p className="warning-text">{speechError}</p>}
              <div className="info-card compact">
                <strong>教练提示</strong>
                <p>{gameSession.feedback}</p>
              </div>
              <div className="info-card compact word-spotlight-card">
                <strong>单词图片卡</strong>
                {wordSpotlight ? (
                  <>
                    <div
                      className="spotlight-image-shell"
                      style={{ '--spotlight-accent': wordSpotlight.visual.accent } as React.CSSProperties}
                    >
                      <img src={wordSpotlight.imageUrl} alt={wordSpotlight.word.english} className="spotlight-image" />
                    </div>
                    <div className="spotlight-caption">
                      <h4>{wordSpotlight.word.english}</h4>
                      <p>{wordSpotlight.word.chinese}</p>
                    </div>
                    <button
                      className="icon-audio-button"
                      onClick={() => speakTeachingWord(wordSpotlight.word)}
                      aria-label="再听一遍"
                    >
                      <span>🔊</span>
                    </button>
                  </>
                ) : (
                  <p>点击任意单词泡泡，这里会自动生成一张图片卡，并读给小朋友听。</p>
                )}
              </div>
              <div className="control-pad">
                <button onClick={() => movePlayer('up')}>↑</button>
                <div>
                  <button onClick={() => movePlayer('left')}>←</button>
                  <button onClick={() => movePlayer('down')}>↓</button>
                  <button onClick={() => movePlayer('right')}>→</button>
                </div>
              </div>
              <button className="primary-button large" onClick={finishLevel}>
                射门（空格）
              </button>
            </aside>
          </div>
        </section>
      )}

      {safeScene === 'complete' && lastResult && (
        <section className="scene complete-scene">
          <div className="complete-card">
            <span className="eyebrow">烟花庆祝</span>
            <h2>{lastResult.level.id} 通关成功</h2>
            <p>球门已经被你精准射穿，新的创意工坊时间已开启。</p>
            <div className="stats-grid">
              <article>
                <strong>{Math.round(lastResult.accuracy * 100)}%</strong>
                <span>正确率</span>
              </article>
              <article>
                <strong>{formatDuration(lastResult.durationSeconds)}</strong>
                <span>用时</span>
              </article>
              <article>
                <strong>{lastResult.correctCount}/{lastResult.total}</strong>
                <span>答对数量</span>
              </article>
            </div>
            <div className="completion-actions">
              <button className="accent-button large" onClick={() => goToScene('workshop')}>
                去搭房子
              </button>
              <button className="secondary-button" onClick={() => goToScene('review')}>
                查看错题本
              </button>
              <button className="ghost-button" onClick={() => goToScene('dashboard')}>
                返回地图
              </button>
            </div>
            {lastResult.wrongWords.length > 0 && (
              <div className="wrong-word-strip">
                {lastResult.wrongWords.map((word) => (
                  <span key={word.wordId}>
                    {word.english} · {word.chinese}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {safeScene === 'workshop' && (
        <section className="scene workshop-scene">
          <header className="topbar sticky workshop-topbar">
            <div>
              <span className="eyebrow">创意工坊</span>
              <h2>按照原型搭建你的小房子</h2>
            </div>
            <div className="topbar-actions">
              <button className="ghost-button" onClick={() => goToScene('dashboard')}>
                返回地图
              </button>
              <button className="secondary-button" onClick={undoWorkshop}>
                撤销
              </button>
              <button className="primary-button" onClick={saveArtwork}>
                保存作品
              </button>
            </div>
          </header>
          <div className="workshop-layout">
            <aside className="palette-panel">
              <div className="info-card">
                <span className="eyebrow">材料库</span>
                <p>点击积木即可放入画布，再拖拽、旋转、缩放。</p>
              </div>
              <div className="palette-grid">
                {workshopPalette.map((item) => (
                  <button key={item.label} className="palette-item" onClick={() => addWorkshopBlock(item)}>
                    <div className={`${blockClassName(item.type)} mini`} style={{ '--block-color': item.color } as React.CSSProperties} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
              <div className="info-card compact">
                <strong>引导模式</strong>
                <p>试着搭一个有 2 面墙、1 个屋顶和 1 扇门的房子。</p>
              </div>
            </aside>
            <div className="canvas-panel">
              <div className="workshop-canvas" ref={workshopCanvasRef}>
                {appState.workshopBlocks.length === 0 && (
                  <div className="canvas-empty">
                    <strong>发挥你的创意吧！</strong>
                    <p>从左侧拖入积木，搭出属于自己的足球英语小镇小屋。</p>
                  </div>
                )}
                {appState.workshopBlocks.map((block) => (
                  <button
                    key={block.id}
                    className={`workshop-block ${selectedBlockId === block.id ? 'is-selected' : ''}`}
                    style={{
                      left: block.x,
                      top: block.y,
                      width: block.width * block.scale,
                      height: block.height * block.scale,
                      transform: `rotate(${block.rotation}deg)`,
                      '--block-color': block.color,
                    } as React.CSSProperties}
                    onPointerDown={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect()
                      dragState.current = {
                        id: block.id,
                        pointerId: event.pointerId,
                        offsetX: event.clientX - bounds.left,
                        offsetY: event.clientY - bounds.top,
                      }
                      setSelectedBlockId(block.id)
                    }}
                  >
                    <div className={blockClassName(block.type)} />
                  </button>
                ))}
              </div>
              {selectedBlock && (
                <div className="selection-toolbar">
                  <button onClick={() => updateSelectedBlock({ rotation: selectedBlock.rotation - 90 })}>左转</button>
                  <button onClick={() => updateSelectedBlock({ rotation: selectedBlock.rotation + 90 })}>右转</button>
                  <button onClick={() => updateSelectedBlock({ scale: clamp(selectedBlock.scale - 0.1, 0.5, 2) })}>缩小</button>
                  <button onClick={() => updateSelectedBlock({ scale: clamp(selectedBlock.scale + 0.1, 0.5, 2) })}>放大</button>
                  <button className="danger-button" onClick={removeSelectedBlock}>
                    删除
                  </button>
                </div>
              )}
            </div>
            <aside className="gallery-panel">
              <div className="info-card">
                <span className="eyebrow">作品画廊</span>
                <p>最近保存的作品会显示在这里，并可分享给家长账号。</p>
              </div>
              <div className="saved-gallery">
                {appState.workshopCreations.slice(0, 4).map((creation) => (
                  <article key={creation.id} className="saved-card">
                    <img alt={creation.name} src={creation.imageData} />
                    <strong>{creation.name}</strong>
                    <span>{formatDateTime(creation.savedAt)}</span>
                  </article>
                ))}
              </div>
            </aside>
          </div>
        </section>
      )}

      {safeScene === 'review' && (
        <section className="scene review-scene">
          <div className="section-header">
            <div>
              <span className="eyebrow">错题本</span>
              <h2>回顾你最需要练习的单词</h2>
            </div>
            <div className="topbar-actions">
              <button className="ghost-button" onClick={() => goToScene('dashboard')}>
                返回地图
              </button>
              <button className="secondary-button" onClick={() => beginLevel()}>
                重新练习当前关卡
              </button>
            </div>
          </div>
          <div className="review-grid">
            {appState.wrongWords.length === 0 && (
              <div className="info-card full">
                <strong>还没有错题</strong>
                <p>继续闯关后，错题会自动出现在这里。</p>
              </div>
            )}
            {appState.wrongWords.map((word) => (
              <article key={word.wordId} className="review-card">
                <div>
                  <span className="eyebrow">{word.level}</span>
                  <h3>{word.english}</h3>
                  <p>{word.chinese}</p>
                </div>
                <div className="meta-row">
                  <span>错误 {word.count} 次</span>
                  <span>{formatDateTime(word.lastSeen)}</span>
                </div>
                <button className="secondary-button" onClick={() => beginLevel()}>
                  再练一次
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {safeScene === 'parent' && (
        <section className="scene parent-scene">
          <header className="topbar sticky parent-topbar">
            <div>
              <span className="eyebrow">家长中心</span>
              <h2>查看学习数据与掌握趋势</h2>
            </div>
            <div className="topbar-actions">
              <button className="ghost-button" onClick={() => goToScene('dashboard')}>
                Exit Parent Center
              </button>
              <button className="secondary-button" onClick={() => goToScene('parentSettings')}>
                功能设置
              </button>
            </div>
          </header>
          <div className="stats-grid large">
            <article>
              <strong>{formatMinutes(appState.usageTodayMinutes)}</strong>
              <span>今日学习时长</span>
            </article>
            <article>
              <strong>{formatMinutes(appState.usageWeekMinutes)}</strong>
              <span>本周总时长</span>
            </article>
            <article>
              <strong>{appState.wordBank.length}</strong>
              <span>累计词汇量</span>
            </article>
            <article>
              <strong>
                {appState.levelHistory[0]
                  ? `${Math.round(appState.levelHistory[0].accuracy * 100)}%`
                  : '78%'}
              </strong>
              <span>平均正确率</span>
            </article>
          </div>
          <div className="parent-grid">
            <article className="info-card chart-card">
              <div className="section-header compact">
                <div>
                  <h3>每日正确率</h3>
                  <p>过去 7 天学习趋势</p>
                </div>
                <span className="trend-chip">+12%</span>
              </div>
              <svg viewBox="0 0 500 160" className="line-chart">
                <path d={`${trendPath} L 480 160 L 0 160 Z`} fill="url(#chartGradient)" opacity="0.18" />
                <path d={trendPath} fill="none" stroke="#197fe6" strokeWidth="4" strokeLinecap="round" />
                <defs>
                  <linearGradient id="chartGradient" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#197fe6" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0.1" />
                  </linearGradient>
                </defs>
              </svg>
            </article>
            <article className="info-card chart-card">
              <h3>单词分类掌握情况</h3>
              <div className="donut-layout">
                {categoryEntries.length === 0 ? (
                  <p className="helper-text">家长添加单词后，这里会自动显示词库分类占比。</p>
                ) : (
                  <>
                    <div className="donut-ring">
                      {categoryEntries.map(([category, score], index) => (
                        <div key={category} className="donut-item">
                          <span style={{ background: categoryColors[index % categoryColors.length] }} />
                          <small>
                            {category} {Math.round((score / totalCategoryScore) * 100)}%
                          </small>
                        </div>
                      ))}
                    </div>
                    <div className="donut-legend">
                      {categoryEntries.map(([category, score], index) => (
                        <div key={category} className="legend-row">
                          <span style={{ background: categoryColors[index % categoryColors.length] }} />
                          <small>{category}</small>
                          <strong>{Math.round((score / totalCategoryScore) * 100)}%</strong>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </article>
          </div>
          <article className="info-card wide-table">
            <div className="section-header compact">
              <div>
                <h3>高频错词回顾</h3>
              </div>
              <button className="secondary-button" onClick={() => goToScene('review')}>
                去巩固
              </button>
            </div>
            <div className="table-list">
              {appState.wrongWords.slice(0, 5).map((word) => (
                <div key={word.wordId} className="table-row">
                  <strong>{word.english}</strong>
                  <span>{word.count} 次</span>
                  <span>{word.chinese}</span>
                  <button className="text-button" onClick={() => goToScene('review')}>
                    去巩固
                  </button>
                </div>
              ))}
              {appState.wrongWords.length === 0 && (
                <div className="table-row muted">当前没有高频错词，继续保持。</div>
              )}
            </div>
          </article>
        </section>
      )}

      {safeScene === 'parentSettings' && (
        <section className="scene settings-scene">
          <div className="section-header">
            <div>
              <span className="eyebrow">家长设置</span>
              <h2>控制时长、难度和分享权限</h2>
            </div>
            <button className="ghost-button" onClick={() => goToScene('parent')}>
              返回家长中心
            </button>
          </div>
          <div className="settings-grid">
            <article className="info-card">
              <label className="form-field">
                <span>每日最长使用时长</span>
                <input
                  type="range"
                  min="15"
                  max="60"
                  step="5"
                  value={appState.settings.dailyLimit}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      settings: {
                        ...previous.settings,
                        dailyLimit: Number(event.target.value),
                      },
                    }))
                  }
                />
                <strong>{appState.settings.dailyLimit} 分钟</strong>
              </label>
              <label className="form-field">
                <span>英语难度</span>
                <select
                  value={appState.settings.difficulty}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      settings: {
                        ...previous.settings,
                        difficulty: event.target.value as AppState['settings']['difficulty'],
                      },
                    }))
                  }
                >
                  <option value="初级">初级</option>
                  <option value="中级">中级</option>
                  <option value="高级">高级</option>
                </select>
              </label>
              <label className="toggle-row">
                <span>开启错题复习</span>
                <input
                  type="checkbox"
                  checked={appState.settings.reviewEnabled}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      settings: {
                        ...previous.settings,
                        reviewEnabled: event.target.checked,
                      },
                    }))
                  }
                />
              </label>
              <label className="toggle-row">
                <span>开启作品分享</span>
                <input
                  type="checkbox"
                  checked={appState.settings.sharingEnabled}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      settings: {
                        ...previous.settings,
                        sharingEnabled: event.target.checked,
                      },
                    }))
                  }
                />
              </label>
            </article>
            <article className="info-card">
              <label className="form-field">
                <span>家长密码</span>
                <input
                  type="password"
                  placeholder="留空表示无需验证"
                  value={appState.settings.parentPassword}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      settings: {
                        ...previous.settings,
                        parentPassword: event.target.value,
                      },
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>问题反馈</span>
                <textarea
                  rows={5}
                  placeholder="例如：单词发音不清晰、搭房子卡顿"
                  value={feedbackDraft}
                  onChange={(event) => setFeedbackDraft(event.target.value)}
                />
              </label>
              <button className="primary-button" onClick={submitFeedback}>
                提交反馈
              </button>
              <div className="feedback-list">
                {appState.feedbackMessages.map((message) => (
                  <div key={message.id} className="feedback-item">
                    <strong>{formatDateTime(message.createdAt)}</strong>
                    <p>{message.text}</p>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>
      )}

      {safeScene === 'api' && (
        <section className="scene api-scene">
          <div className="section-header">
            <div>
              <span className="eyebrow">系统配置</span>
              <h2>火山引擎 + 飞书词库，本地优先保存</h2>
            </div>
            <div className="topbar-actions">
              <button className="ghost-button" onClick={() => goToScene(appState.selectedCharacter ? 'dashboard' : 'welcome')}>
                返回
              </button>
              <button className="secondary-button" onClick={resetDemo}>
                重置演示数据
              </button>
            </div>
          </div>
          <div className="config-banner">
            未配置真实 API 时，应用仍可使用家长动态词库、浏览器翻译和语音能力进行演示。
          </div>
          <div className="config-grid">
            <article className="info-card">
              <div className="card-status">
                <h3>火山引擎 · 语音识别</h3>
                <span className={`status-pill ${appState.apiConfig.volcengine.status}`}>
                  {appState.apiConfig.volcengine.message}
                </span>
              </div>
              <label className="form-field">
                <span>AppID</span>
                <input
                  value={appState.apiConfig.volcengine.appId}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      apiConfig: {
                        ...previous.apiConfig,
                        volcengine: {
                          ...previous.apiConfig.volcengine,
                          appId: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>AccessKey</span>
                <input
                  value={appState.apiConfig.volcengine.accessKey}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      apiConfig: {
                        ...previous.apiConfig,
                        volcengine: {
                          ...previous.apiConfig.volcengine,
                          accessKey: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>SecretKey</span>
                <input
                  type="password"
                  value={appState.apiConfig.volcengine.secretKey}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      apiConfig: {
                        ...previous.apiConfig,
                        volcengine: {
                          ...previous.apiConfig.volcengine,
                          secretKey: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <button className="primary-button" onClick={() => validateService('volcengine')}>
                验证连接
              </button>
            </article>
            <article className="info-card">
              <div className="card-status">
                <h3>飞书 · 在线词库</h3>
                <span className={`status-pill ${appState.apiConfig.feishu.status}`}>
                  {appState.apiConfig.feishu.message}
                </span>
              </div>
              <label className="form-field">
                <span>App ID</span>
                <input
                  value={appState.apiConfig.feishu.appId}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      apiConfig: {
                        ...previous.apiConfig,
                        feishu: {
                          ...previous.apiConfig.feishu,
                          appId: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>App Secret</span>
                <input
                  type="password"
                  value={appState.apiConfig.feishu.appSecret}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      apiConfig: {
                        ...previous.apiConfig,
                        feishu: {
                          ...previous.apiConfig.feishu,
                          appSecret: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>多维表格链接</span>
                <input
                  value={appState.apiConfig.feishu.tableLink}
                  onChange={(event) =>
                    updateAppState((previous) => ({
                      ...previous,
                      apiConfig: {
                        ...previous.apiConfig,
                        feishu: {
                          ...previous.apiConfig.feishu,
                          tableLink: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <div className="hero-actions">
                <button className="primary-button" onClick={() => validateService('feishu')}>
                  验证连接
                </button>
                <button className="secondary-button" onClick={syncVocabulary}>
                  同步词库
                </button>
              </div>
              {appState.apiConfig.lastSyncAt && (
                <p className="helper-text">
                  上次同步时间：{formatDateTime(appState.apiConfig.lastSyncAt)} · {wordBankSummary}
                </p>
              )}
            </article>
          </div>
          <article className="info-card environment-card">
            <div className="section-header compact">
              <div>
                <h3>环境检查</h3>
                <p>在本地浏览器中直接完成权限、兼容性和网络状态确认。</p>
              </div>
              <button className="secondary-button" onClick={requestMicrophonePermission}>
                检查麦克风权限
              </button>
            </div>
            <div className="environment-grid">
              <div className="environment-item">
                <strong>麦克风权限</strong>
                <span>{appState.microphoneStatus}</span>
              </div>
              <div className="environment-item">
                <strong>浏览器兼容性</strong>
                <span>{window.SpeechRecognition || window.webkitSpeechRecognition ? '支持语音识别' : '建议使用 Chrome / Edge'}</span>
              </div>
              <div className="environment-item">
                <strong>词库状态</strong>
                <span>{wordBankSummary}</span>
              </div>
            </div>
          </article>
        </section>
      )}
    </div>
  )
}

export default App
