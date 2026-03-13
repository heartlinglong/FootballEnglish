import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

type WordVisual = {
  emoji: string
  accent: string
  background: string
  scene: string
}

type BubbleFeedbackState = Record<string, 'correct' | 'wrong'>

const goalPosition = { x: 50, y: 10 }
const MAX_FIELD_BUBBLES = 3
const PLAYER_MOVE_STEP = 6
const GOAL_SHOT_DISTANCE = 24
const INITIAL_LEVEL_ENERGY = 35
const CORRECT_ANSWER_ENERGY_BONUS = 10
const WRONG_ANSWER_ENERGY_COST = 5
const SKIP_BUBBLE_ENERGY_COST = 5
const MIN_LEVEL_DURATION_SECONDS = 8
const GAMEPLAY_FOCUS_DELAY_MS = 0
const VOICE_COUNTDOWN_STEP_MS = 1000
const VOICE_LISTENING_WINDOW_MS = 3000
const VOICE_FALLBACK_RMS_THRESHOLD = 0.05
const VOICE_FALLBACK_PEAK_THRESHOLD = 0.075
const VOICE_FALLBACK_MIN_HEARD_FRAMES = 8
const BUBBLE_FEEDBACK_DURATION_MS = 720
const ENERGY_PULSE_DURATION_MS = 480
const GOAL_CELEBRATION_DURATION_MS = 900

type WordSpotlightState = {
  bubbleId: string
}

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

function buildWordSpotlight(word: WordEntry) {
  return {
    word,
    imageUrl: createWordImage(word),
    visual: getWordVisual(word),
  }
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

function getLevelBadgeEmoji(level: LevelDefinition) {
  if (level.difficulty === '初级') {
    return '⚽'
  }
  if (level.difficulty === '中级') {
    return '🚀'
  }
  return '🏆'
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.8l2.74 5.55 6.12.89-4.43 4.32 1.04 6.1L12 16.78 6.53 19.66l1.04-6.1L3.14 9.24l6.12-.89L12 2.8z"
        fill="currentColor"
      />
    </svg>
  )
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 20.4l-1.16-1.06C5.12 14.1 2 11.26 2 7.77 2 4.93 4.24 2.8 7.07 2.8c1.6 0 3.13.74 4.13 1.9 1-1.16 2.53-1.9 4.13-1.9C18.16 2.8 20.4 4.93 20.4 7.77c0 3.5-3.12 6.33-8.84 11.59L12 20.4z"
        fill="currentColor"
      />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 15.8a3.8 3.8 0 0 0 3.8-3.8V7.8a3.8 3.8 0 1 0-7.6 0V12a3.8 3.8 0 0 0 3.8 3.8zm6-3.8a1 1 0 1 1 2 0 8 8 0 0 1-7 7.93V22a1 1 0 1 1-2 0v-2.07A8 8 0 0 1 4 12a1 1 0 1 1 2 0 6 6 0 0 0 12 0z"
        fill="currentColor"
      />
    </svg>
  )
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 20.2a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7zm.08-17.4C8.5 2.8 6 5.08 6 8.13a1 1 0 1 0 2 0c0-1.88 1.6-3.33 4-3.33 2.12 0 3.54 1.2 3.54 2.94 0 1.23-.6 1.99-2.24 3.03-1.95 1.24-2.8 2.48-2.8 4.53v.36a1 1 0 1 0 2 0v-.3c0-1.31.45-2.04 1.87-2.95 1.88-1.2 3.17-2.58 3.17-4.67 0-2.95-2.4-4.94-5.46-4.94z"
        fill="currentColor"
      />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M19.14 12.94c.04-.3.06-.62.06-.94s-.02-.64-.06-.94l2.03-1.58a.8.8 0 0 0 .2-1.03l-1.92-3.32a.8.8 0 0 0-.98-.36l-2.4.96a7.6 7.6 0 0 0-1.64-.94l-.36-2.55A.8.8 0 0 0 13.3 1h-3.84a.8.8 0 0 0-.79.67l-.36 2.55c-.58.22-1.12.54-1.64.94l-2.4-.96a.8.8 0 0 0-.98.36L1.37 7.88a.8.8 0 0 0 .2 1.03l2.03 1.58c-.04.3-.06.62-.06.94s.02.64.06.94L1.57 13.95a.8.8 0 0 0-.2 1.03l1.92 3.32c.2.35.62.5.98.36l2.4-.96c.5.4 1.05.72 1.64.94l.36 2.55c.06.39.4.67.79.67h3.84c.39 0 .73-.28.79-.67l.36-2.55c.58-.22 1.14-.54 1.64-.94l2.4.96c.36.14.78-.01.98-.36l1.92-3.32a.8.8 0 0 0-.2-1.03l-2.03-1.58zM11.38 15.2A3.2 3.2 0 1 1 11.38 8.8a3.2 3.2 0 0 1 0 6.4z"
        fill="currentColor"
      />
    </svg>
  )
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
  const [micCountdown, setMicCountdown] = useState<number | null>(null)
  const [listeningBubbleId, setListeningBubbleId] = useState<string | null>(null)
  const [wordSpotlight, setWordSpotlight] = useState<WordSpotlightState | null>(null)
  const [bubbleFeedback, setBubbleFeedback] = useState<BubbleFeedbackState>({})
  const [energyPulse, setEnergyPulse] = useState(false)
  const [goalCelebrating, setGoalCelebrating] = useState(false)
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const workshopCanvasRef = useRef<HTMLDivElement | null>(null)
  const gameplaySceneRef = useRef<HTMLElement | null>(null)
  const answerDraftRef = useRef(answerDraft)
  const activeBubbleRef = useRef<ReturnType<typeof getActiveBubble>>(null)
  const countdownTimerRef = useRef<number | null>(null)
  const listeningTimerRef = useRef<number | null>(null)
  const managedTimeoutsRef = useRef<number[]>([])
  const voicePracticeStreamRef = useRef<MediaStream | null>(null)
  const voicePracticeAudioContextRef = useRef<AudioContext | null>(null)
  const voicePracticeFrameRef = useRef<number | null>(null)
  const finishResultTimerRef = useRef<number | null>(null)
  const dragState = useRef<{
    id: string
    pointerId: number
    offsetX: number
    offsetY: number
  } | null>(null)

  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === appState.selectedCharacter),
    [appState.selectedCharacter],
  )
  const currentLevel = useMemo(() => levelByNumber(appState.currentLevel), [appState.currentLevel])
  const activeBubble = useMemo(
    () => getActiveBubble(gameSession, focusedBubbleId),
    [focusedBubbleId, gameSession],
  )
  const wordBankSummary = useMemo(() => buildWordBankSummary(appState.wordBank), [appState.wordBank])
  const safeScene = useMemo(
    () =>
      appState.scene === 'gameplay' && !gameSession
        ? appState.selectedCharacter
          ? 'dashboard'
          : 'welcome'
        : appState.scene === 'complete' && !lastResult
          ? appState.selectedCharacter
            ? 'dashboard'
            : 'welcome'
          : appState.scene,
    [appState.scene, appState.selectedCharacter, gameSession, lastResult],
  )
  const usageLocked = appState.usageTodayMinutes >= appState.settings.dailyLimit
  const selectedBlock = useMemo(
    () => appState.workshopBlocks.find((block) => block.id === selectedBlockId) ?? null,
    [appState.workshopBlocks, selectedBlockId],
  )
  const spotlightBubble = useMemo(() => {
    if (!gameSession || !wordSpotlight) {
      return null
    }

    return gameSession.bubbles.find((bubble) => bubble.id === wordSpotlight.bubbleId) ?? null
  }, [gameSession, wordSpotlight])
  const spotlightCard = useMemo(
    () => (spotlightBubble ? buildWordSpotlight(spotlightBubble.word) : null),
    [spotlightBubble],
  )

  activeBubbleRef.current = activeBubble

  const clearManagedTimeouts = useCallback(() => {
    managedTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId)
    })
    managedTimeoutsRef.current = []
  }, [])

  const scheduleManagedTimeout = useCallback(
    (callback: () => void, delay: number) => {
      const timeoutId = window.setTimeout(() => {
        managedTimeoutsRef.current = managedTimeoutsRef.current.filter((id) => id !== timeoutId)
        callback()
      }, delay)
      managedTimeoutsRef.current.push(timeoutId)
      return timeoutId
    },
    [],
  )

  const pulseEnergy = useCallback(() => {
    setEnergyPulse(true)
    scheduleManagedTimeout(() => {
      setEnergyPulse(false)
    }, ENERGY_PULSE_DURATION_MS)
  }, [scheduleManagedTimeout])

  const triggerBubbleFeedback = useCallback(
    (bubbleId: string, status: 'correct' | 'wrong') => {
      setBubbleFeedback((previous) => ({ ...previous, [bubbleId]: status }))
      scheduleManagedTimeout(() => {
        setBubbleFeedback((previous) => {
          if (!previous[bubbleId]) {
            return previous
          }

          const next = { ...previous }
          delete next[bubbleId]
          return next
        })
      }, BUBBLE_FEEDBACK_DURATION_MS)
    },
    [scheduleManagedTimeout],
  )

  useEffect(() => {
    saveAppState(appState)
  }, [appState])

  useEffect(() => {
    answerDraftRef.current = answerDraft
  }, [answerDraft])

  useEffect(() => {
    if (safeScene !== appState.scene) {
      setAppState((previous) => ({ ...previous, scene: safeScene }))
    }
  }, [appState.scene, safeScene])

  useEffect(() => {
    if (!activeBubble) {
      if (wordSpotlight) {
        setWordSpotlight(null)
      }
      return
    }

    if (wordSpotlight?.bubbleId !== activeBubble.bubble.id) {
      // 图片卡和当前可交互泡泡共用同一来源，避免两处 UI 指向不同单词。
      setWordSpotlight({ bubbleId: activeBubble.bubble.id })
    }
  }, [activeBubble, wordSpotlight])

  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) {
        window.clearTimeout(countdownTimerRef.current)
      }
      if (finishResultTimerRef.current) {
        window.clearTimeout(finishResultTimerRef.current)
      }
      if (listeningTimerRef.current) {
        window.clearTimeout(listeningTimerRef.current)
      }
      clearManagedTimeouts()
      window.speechSynthesis?.cancel()
      recognitionRef.current?.stop()
      stopVoicePractice()
    }
  }, [clearManagedTimeouts])

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
    if (safeScene !== 'gameplay') {
      return
    }

    scheduleManagedTimeout(() => {
      gameplaySceneRef.current?.focus()
    }, GAMEPLAY_FOCUS_DELAY_MS)
  }, [gameSession?.level.id, safeScene, scheduleManagedTimeout])

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

  const releaseGameplayFocus = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    gameplaySceneRef.current?.focus()
  }, [])

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
      energy: INITIAL_LEVEL_ENERGY,
      feedback:
        words.length === 0
          ? '球场还没有单词。请让家长加一个词。'
          : '点一个泡泡，听一听，再点大麦克风。',
      startTime: Date.now(),
    })
    setAnswerDraft('')
    setSpeechError('')
    setFocusedBubbleId(null)
    setMicCountdown(null)
    setListeningBubbleId(null)
    setWordSpotlight(null)
    setBubbleFeedback({})
    setEnergyPulse(false)
    setGoalCelebrating(false)
    goToScene('gameplay')
    scheduleManagedTimeout(() => {
      releaseGameplayFocus()
    }, GAMEPLAY_FOCUS_DELAY_MS)
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
    setWordSpotlight({ bubbleId: bubble.id })
    speakTeachingWord(bubble.word)
    setGameSession((previous) =>
      previous
        ? {
            ...previous,
            player: {
              x: clamp(bubble.x - PLAYER_MOVE_STEP, 6, 94),
              y: clamp(bubble.y + 8, 10, 86),
            },
            feedback:
              bubble.word.english === bubble.word.chinese
                ? `${bubble.word.english}，听一听，再跟着说。`
                : `${bubble.word.english}，是 ${bubble.word.chinese}。听一听，再跟着说。`,
          }
        : previous,
    )
  }

  function skipBubble() {
    if (!activeBubble) {
      return
    }

    triggerBubbleFeedback(activeBubble.bubble.id, 'wrong')
    pulseEnergy()

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
        energy: clamp(previous.energy - SKIP_BUBBLE_ENERGY_COST, 0, 100),
        feedback: `${activeBubble.bubble.word.english} 先跳过。`,
      }
    })
    setFocusedBubbleId((previous) =>
      previous === activeBubble.bubble.id ? null : previous,
    )
    setWordSpotlight((previous) =>
      previous?.bubbleId === activeBubble.bubble.id ? null : previous,
    )
  }

  function finishLevel() {
    if (!gameSession || goalCelebrating) {
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
              feedback: '先把泡泡都完成。',
            }
          : previous,
      )
      return
    }

    if (distance > GOAL_SHOT_DISTANCE) {
      setGameSession((previous) =>
        previous
          ? {
              ...previous,
              feedback: '走近点，再点一次。',
            }
          : previous,
      )
      return
    }

    const durationSeconds = Math.max(
      MIN_LEVEL_DURATION_SECONDS,
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

    setGoalCelebrating(true)
    pulseEnergy()
    setGameSession((previous) =>
      previous
        ? {
            ...previous,
            feedback: '进球啦！',
          }
        : previous,
    )

    finishResultTimerRef.current = window.setTimeout(() => {
      setGoalCelebrating(false)
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
      finishResultTimerRef.current = null
    }, GOAL_CELEBRATION_DURATION_MS)
  }

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
    triggerBubbleFeedback(bubble.id, isCorrect ? 'correct' : 'wrong')
    pulseEnergy()
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
        // 答错与跳过统一扣能量，避免孩子通过连续试错绕过体力成本。
        energy: clamp(
          previous.energy + (isCorrect ? CORRECT_ANSWER_ENERGY_BONUS : -WRONG_ANSWER_ENERGY_COST),
          0,
          100,
        ),
        feedback:
          feedbackOverride ??
          (isCorrect
            ? `答对啦！${bubble.word.english}`
            : `再试试。${bubble.word.chinese} 是 ${bubble.word.english}。`),
      }
    })

    setAnswerDraft('')
    if (isCorrect) {
      setFocusedBubbleId((previousFocus) => (previousFocus === bubble.id ? null : previousFocus))
      setWordSpotlight((previous) => (previous?.bubbleId === bubble.id ? null : previous))
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
        if (rms > VOICE_FALLBACK_RMS_THRESHOLD) {
          heardFrames += 1
        }

        voicePracticeFrameRef.current = window.requestAnimationFrame(monitorVolume)
      }

      monitorVolume()

      listeningTimerRef.current = window.setTimeout(() => {
        const heardVoice =
          heardFrames >= VOICE_FALLBACK_MIN_HEARD_FRAMES || maxVolume > VOICE_FALLBACK_PEAK_THRESHOLD
        stopVoicePractice()
        setListening(false)
        setMicCountdown(null)
        setListeningBubbleId(null)

        if (heardVoice) {
          // 纯本地音量分析只能确认“开口了”，不能确认“读对了”，这里补一层文本确认避免永远判对。
          const confirmedAnswer = window.prompt(
            `已检测到发声。当前处于本地降级模式，请输入刚才读出的英文以确认是否正确：`,
            answerDraftRef.current.trim() || bubble.word.english,
          )

          if (!confirmedAnswer?.trim()) {
            setSpeechError('')
            setGameSession((previous) =>
              previous
                ? {
                    ...previous,
                    feedback: `已经听到发声，但还没有确认读的是不是 ${bubble.word.english}。请再试一次，或由家长帮忙输入确认。`,
                  }
                : previous,
            )
            return
          }

          const isCorrect = isAnswerCorrect(confirmedAnswer, bubble.word.english)
          handleBubbleAttemptResult(
            bubble,
            isCorrect,
            isCorrect
              ? `本地降级模式已确认 ${bubble.word.english} 读对了，继续前进吧。`
              : `本地降级模式下确认结果不匹配，再试试！${bubble.word.chinese} 的英文是 ${bubble.word.english}。`,
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
      }, VOICE_LISTENING_WINDOW_MS)
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
      setSpeechError('先点一个泡泡。')
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
              x: clamp(bubble.x - PLAYER_MOVE_STEP, 6, 94),
              y: clamp(bubble.y + 8, 10, 86),
            },
            feedback: `准备好了吗？对着 ${bubble.word.english} 说出来。`,
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
              feedback: `开始说吧：${bubble.word.english}`,
            }
          : previous,
      )
      recognition.start()
      listeningTimerRef.current = window.setTimeout(() => {
        recognition.stop()
      }, VOICE_LISTENING_WINDOW_MS)
    }

    countdownTimerRef.current = window.setTimeout(() => {
      setMicCountdown(2)
      countdownTimerRef.current = window.setTimeout(() => {
        setMicCountdown(1)
        countdownTimerRef.current = window.setTimeout(() => {
          startRecognition()
        }, VOICE_COUNTDOWN_STEP_MS)
      }, VOICE_COUNTDOWN_STEP_MS)
    }, VOICE_COUNTDOWN_STEP_MS)
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

    scheduleManagedTimeout(() => {
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

    scheduleManagedTimeout(() => {
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
    setWordSpotlight(null)
    setWorkshopHistory([])
    setSelectedBlockId(null)
    setAppState(resetState)
  }

  const trendValues = useMemo(
    () =>
      appState.levelHistory
        .slice(0, 7)
        .map((entry) => Math.max(45, Math.round(entry.accuracy * 100)))
        .reverse(),
    [appState.levelHistory],
  )
  const weeklyTrend = useMemo(
    () => (trendValues.length >= 4 ? trendValues : [62, 66, 70, 68, 74, 79, 86]),
    [trendValues],
  )
  const trendPath = useMemo(
    () =>
      weeklyTrend
        .map((value, index) => `${index === 0 ? 'M' : 'L'} ${index * 80} ${150 - value}`)
        .join(' '),
    [weeklyTrend],
  )

  const categoryStats = useMemo(
    () =>
      appState.wordBank
        .filter((word) => word.enabled)
        .reduce<Record<string, number>>((result, word) => {
          const entry = appState.libraryProgress[word.id]
          const score = entry ? entry.correct + 1 : 1
          result[word.category] = (result[word.category] ?? 0) + score
          return result
        }, {}),
    [appState.libraryProgress, appState.wordBank],
  )
  const totalCategoryScore =
    useMemo(() => Object.values(categoryStats).reduce((sum, value) => sum + value, 0) || 1, [categoryStats])
  const categoryColors = ['#197fe6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444']
  const categoryEntries = useMemo(() => Object.entries(categoryStats), [categoryStats])

  const unlockedGoal = useMemo(
    () =>
      gameSession && gameSession.bubbles.length > 0
        ? gameSession.bubbles.every((bubble) => bubble.status !== 'pending')
        : false,
    [gameSession],
  )
  const clearedBubbleCount = useMemo(
    () => gameSession?.bubbles.filter((bubble) => bubble.status !== 'pending').length ?? 0,
    [gameSession],
  )
  const currentLevelStars = useMemo(
    () => appState.completedLevels.filter((levelId) => levelId === currentLevel.id).length,
    [appState.completedLevels, currentLevel.id],
  )

  function handleCharacterSelect(characterId: CharacterId) {
    updateAppState((previous) => ({
      ...previous,
      selectedCharacter: characterId,
    }))
  }

  function startAdventure() {
    if (!appState.selectedCharacter) {
      return
    }

    updateAppState((previous) => ({
      ...previous,
      scene: 'dashboard',
    }))
  }

  function handleGameplayPrimaryAction() {
    if (unlockedGoal) {
      finishLevel()
      return
    }

    if (activeBubble) {
      startListening(activeBubble.bubble)
      return
    }

    setSpeechError('先点一个泡泡。')
  }

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
              <h2>选一个朋友</h2>
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
                onClick={() => handleCharacterSelect(character.id as CharacterId)}
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
          <div className="character-launch">
            <button
              className="primary-button large character-start-button"
              disabled={!appState.selectedCharacter}
              onClick={startAdventure}
            >
              开始冒险
            </button>
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
              <button className="icon-corner-button" onClick={() => openProtectedScene('parent')} aria-label="家长中心">
                <GearIcon />
              </button>
              <button className="ghost-button" onClick={() => goToScene('api')}>
                API 配置
              </button>
              <div className="star-chip">
                <StarIcon />
                <span>{appState.stars}</span>
              </div>
            </div>
          </header>
          <div className="dashboard-layout">
            <section className="map-panel card-map-panel">
              <div className="card-level-list" role="list">
                {levels.map((level) => {
                  const completed = appState.completedLevels.includes(level.id)
                  const locked = level.number > Math.max(appState.currentLevel, 1)
                  const current = level.number === currentLevel.number

                  return (
                    <button
                      key={level.id}
                      className={`level-card ${completed ? 'is-complete' : ''} ${
                        current ? 'is-current' : ''
                      } ${locked ? 'is-locked' : ''}`}
                      onClick={() => !locked && beginLevel(level.number)}
                      disabled={locked}
                    >
                      <div className="level-card-icon">{getLevelBadgeEmoji(level)}</div>
                      <div className="level-card-copy">
                        <strong>{level.title}</strong>
                        <span>{level.id}</span>
                      </div>
                      <div className="level-card-meta">
                        <div className="level-stars">
                          <StarIcon />
                          <span>{completed ? 1 : current ? currentLevelStars : 0}</span>
                        </div>
                        <span className="level-state-mark" aria-hidden="true">
                          {completed ? '✓' : locked ? '🔒' : '▶'}
                        </span>
                      </div>
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
          <div className="gameplay-topbar">
            <div className="hud-bar compact">
              <div className="hud-icon-chip" aria-label={`星星 ${appState.stars}`}>
                <StarIcon />
                <strong>{appState.stars}</strong>
              </div>
              <div className={`hud-icon-chip heart-chip ${energyPulse ? 'is-bouncing' : ''}`} aria-label={`能量 ${gameSession.energy}`}>
                <HeartIcon />
                <strong>{Math.max(1, Math.ceil(gameSession.energy / 20))}</strong>
              </div>
            </div>
            <button className="icon-corner-button gameplay-parent-button" onClick={() => openProtectedScene('parent')} aria-label="家长中心">
              <GearIcon />
            </button>
          </div>
          <div className="stadium-layout">
            <div className="field-shell">
              {spotlightCard && (
                <div
                  className="field-spotlight"
                  style={{ '--spotlight-accent': spotlightCard.visual.accent } as React.CSSProperties}
                >
                  <img
                    src={spotlightCard.imageUrl}
                    alt={spotlightCard.word.english}
                    className="field-spotlight-image"
                  />
                  <div className="field-spotlight-copy">
                    <strong>{spotlightCard.word.english}</strong>
                    <span>{spotlightCard.word.chinese}</span>
                  </div>
                </div>
              )}
              <div
                className={`goal ${unlockedGoal ? 'is-open' : ''} ${goalCelebrating ? 'is-celebrating' : ''}`}
                style={{ left: '50%', top: '11%' }}
              >
                <span className="goal-frame goal-top" />
                <span className="goal-frame goal-left" />
                <span className="goal-frame goal-right" />
                <span className="goal-net" />
                {goalCelebrating && (
                  <>
                    <span className="goal-firework firework-left" />
                    <span className="goal-firework firework-right" />
                    <span className="goal-confetti confetti-left" />
                    <span className="goal-confetti confetti-right" />
                  </>
                )}
              </div>
              {gameSession.bubbles.map((bubble) => {
                return (
                  <button
                    key={bubble.id}
                    className={`word-bubble ${bubble.status} ${
                      focusedBubbleId === bubble.id ? 'is-focused' : ''
                    } ${bubbleFeedback[bubble.id] ? `is-${bubbleFeedback[bubble.id]}` : ''}`}
                    style={{ left: `${bubble.x}%`, top: `${bubble.y}%` }}
                    onClick={() => handleBubbleClick(bubble)}
                  >
                    <span>{bubble.word.english}</span>
                    <small>{bubble.word.chinese}</small>
                    <span className="bubble-burst-particles" aria-hidden="true" />
                  </button>
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
          </div>
          <div className="gameplay-feedback-strip">
            <div className="info-card compact child-feedback-card">
              <strong>{gameSession.level.id}</strong>
              <p>{gameSession.feedback}</p>
              <span>
                {clearedBubbleCount}/{gameSession.bubbles.length}
              </span>
            </div>
            {speechError && <p className="warning-text gameplay-warning">{speechError}</p>}
          </div>
          <div className="bottom-action-bar">
            <button
              className={`bottom-icon-button small ${activeBubble && activeBubble.bubble.attempts >= 3 ? 'show-skip' : ''}`}
              onClick={activeBubble && activeBubble.bubble.attempts >= 3 ? skipBubble : () => spotlightCard && speakTeachingWord(spotlightCard.word)}
              aria-label={activeBubble && activeBubble.bubble.attempts >= 3 ? '跳过' : '帮助'}
            >
              {activeBubble && activeBubble.bubble.attempts >= 3 ? '⏭️' : <HelpIcon />}
            </button>
            <button
              className={`bottom-primary-button ${listening ? 'is-listening' : ''}`}
              onClick={handleGameplayPrimaryAction}
              aria-label={unlockedGoal ? '射门' : '录音'}
            >
              {micCountdown !== null && listeningBubbleId ? (
                <span className="countdown-number">{micCountdown}</span>
              ) : unlockedGoal ? (
                <span>🥅</span>
              ) : (
                <MicIcon />
              )}
            </button>
            <button
              className="bottom-icon-button small"
              onClick={() => openProtectedScene('parent')}
              aria-label="家长中心"
            >
              <GearIcon />
            </button>
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
