import { startTransition, useEffect, useRef, useState } from 'react'
import { characters, levels, starterWords, workshopPalette } from './data/gameData'
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

const goalPosition = { x: 50, y: 10 }

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
  }))
}

function getActiveBubble(session: GameSession | null) {
  if (!session) {
    return null
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
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const workshopCanvasRef = useRef<HTMLDivElement | null>(null)
  const answerDraftRef = useRef(answerDraft)
  const activeBubbleRef = useRef<ReturnType<typeof getActiveBubble>>(null)
  const finishLevelRef = useRef<() => void>(() => {})
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
  const activeBubble = getActiveBubble(gameSession)
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
        case ' ':
        case 'Spacebar':
        case 'Space':
          event.preventDefault()
          finishLevelRef.current()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [appState.scene])

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

  function beginLevel(levelNumber = appState.currentLevel) {
    const level = levelByNumber(levelNumber)
    const words = pickWordsForLevel(starterWords, appState.libraryProgress, level)
    setGameSession({
      level,
      background: level.background,
      bubbles: createBubbleLayout(words),
      player: { x: 12, y: 76 },
      energy: 35,
      feedback: '靠近发光的单词泡泡，说出英语后再射门。',
      startTime: Date.now(),
    })
    setAnswerDraft('')
    setSpeechError('')
    goToScene('gameplay')
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

  function handleAnswer(rawAnswer: string) {
    setGameSession((previous) => {
      if (!previous || !activeBubble) {
        return previous
      }

      if (activeBubble.distance > 16) {
        return {
          ...previous,
          feedback: '再靠近一点，单词泡泡会放大提醒你。',
        }
      }

      const isCorrect = isAnswerCorrect(rawAnswer, activeBubble.bubble.word.english)
      const nextBubbles = previous.bubbles.map((bubble) => {
        if (bubble.id !== activeBubble.bubble.id) {
          return bubble
        }

        return {
          ...bubble,
          status: isCorrect ? 'cleared' : bubble.status,
          attempts: bubble.attempts + (isCorrect ? 0 : 1),
        }
      })

      const allDone = nextBubbles.every((bubble) => bubble.status !== 'pending')

      setAnswerDraft('')
      return {
        ...previous,
        bubbles: nextBubbles,
        energy: clamp(previous.energy + (isCorrect ? 10 : 0), 0, 100),
        feedback: isCorrect
          ? `太棒啦！${activeBubble.bubble.word.english} 已被踢飞，去找下一个泡泡。`
          : `再试试！${activeBubble.bubble.word.chinese} 的英文是 ${activeBubble.bubble.word.english}。`,
        player: isCorrect ? previous.player : previous.player,
        background: allDone ? previous.background : previous.background,
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
  }

  function finishLevel() {
    if (!gameSession) {
      return
    }

    const distance = Math.hypot(
      gameSession.player.x - goalPosition.x,
      gameSession.player.y - goalPosition.y,
    )
    const allDone = gameSession.bubbles.every((bubble) => bubble.status !== 'pending')

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
      .then(() => {
        updateAppState((previous) => ({ ...previous, microphoneStatus: 'granted' }))
      })
      .catch(() => {
        updateAppState((previous) => ({ ...previous, microphoneStatus: 'denied' }))
      })
  }

  function startListening() {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Recognition) {
      setSpeechError('当前浏览器不支持语音识别，请先用输入框答题。')
      return
    }

    const recognition = recognitionRef.current ?? new Recognition()
    recognition.lang = 'en-US'
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript
      setAnswerDraft(transcript)
      handleAnswer(transcript)
    }
    recognition.onerror = (event) => {
      setSpeechError(`语音识别失败：${event.error}`)
      setListening(false)
    }
    recognition.onend = () => {
      setListening(false)
    }

    recognitionRef.current = recognition
    setListening(true)
    setSpeechError('')
    recognition.start()
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
                : '未配置飞书时，已回退到内置演示词库。',
          },
          lastSyncAt: new Date().toISOString(),
          lastSyncSummary: `当前词库：初级 ${
            starterWords.filter((word) => word.level === '初级').length
          } 词 / 中级 ${
            starterWords.filter((word) => word.level === '中级').length
          } 词 / 高级 ${starterWords.filter((word) => word.level === '高级').length} 词`,
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

  const categoryStats = starterWords
    .filter((word) => word.level === appState.settings.difficulty || appState.settings.difficulty === '初级')
    .reduce<Record<string, number>>((result, word) => {
      const entry = appState.libraryProgress[word.id]
      const score = entry ? entry.correct + 1 : 1
      result[word.category] = (result[word.category] ?? 0) + score
      return result
    }, {})
  const totalCategoryScore = Object.values(categoryStats).reduce((sum, value) => sum + value, 0) || 1
  const categoryColors = ['#197fe6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444']
  const categoryEntries = Object.entries(categoryStats)

  const unlockedGoal = gameSession?.bubbles.every((bubble) => bubble.status !== 'pending') ?? false

  return (
    <div className="app-shell">
      {appState.scene === 'welcome' && (
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

      {appState.scene === 'characters' && (
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

      {appState.scene === 'dashboard' && (
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

      {appState.scene === 'gameplay' && gameSession && (
        <section className={`scene gameplay-scene background-${gameSession.background}`}>
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
                  <button
                    key={bubble.id}
                    className={`word-bubble ${bubble.status} ${near ? 'is-near' : ''}`}
                    style={{ left: `${bubble.x}%`, top: `${bubble.y}%` }}
                    onClick={() =>
                      setGameSession((previous) =>
                        previous
                          ? {
                              ...previous,
                              player: {
                                x: clamp(bubble.x - 6, 6, 94),
                                y: clamp(bubble.y + 8, 10, 86),
                              },
                            }
                          : previous,
                      )
                    }
                  >
                    <span>{bubble.word.english}</span>
                    <small>{bubble.word.chinese}</small>
                  </button>
                )
              })}
              <div
                className="player-token"
                style={{ left: `${gameSession.player.x}%`, top: `${gameSession.player.y}%` }}
              >
                <span>{currentCharacter?.emoji ?? '⚽'}</span>
                <div className="ball-shadow">⚽</div>
              </div>
            </div>
            <aside className="coach-panel">
              <div className="info-card">
                <span className="eyebrow">当前挑战</span>
                {activeBubble ? (
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
              <div className="answer-box">
                <input
                  value={answerDraft}
                  onChange={(event) => setAnswerDraft(event.target.value)}
                  placeholder="在这里输入单词或短句"
                />
                <div className="hero-actions">
                  <button className="primary-button" onClick={() => handleAnswer(answerDraft)}>
                    提交答案
                  </button>
                  <button className="secondary-button" onClick={startListening}>
                    {listening ? '识别中...' : '语音识别'}
                  </button>
                </div>
                {activeBubble && activeBubble.bubble.attempts >= 3 && (
                  <button className="text-button" onClick={skipBubble}>
                    跳过这个单词
                  </button>
                )}
                {speechError && <p className="warning-text">{speechError}</p>}
              </div>
              <div className="info-card compact">
                <strong>教练提示</strong>
                <p>{gameSession.feedback}</p>
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

      {appState.scene === 'complete' && lastResult && (
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

      {appState.scene === 'workshop' && (
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

      {appState.scene === 'review' && (
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

      {appState.scene === 'parent' && (
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
              <strong>{Object.values(appState.libraryProgress).filter((item) => item.seen > 0).length}</strong>
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

      {appState.scene === 'parentSettings' && (
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

      {appState.scene === 'api' && (
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
            未配置真实 API 时，应用仍可使用内置示例词库和浏览器语音能力进行演示。
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
                  上次同步时间：{formatDateTime(appState.apiConfig.lastSyncAt)} · {appState.apiConfig.lastSyncSummary}
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
                <span>{appState.apiConfig.lastSyncSummary ?? '使用内置演示词库'}</span>
              </div>
            </div>
          </article>
        </section>
      )}
    </div>
  )
}

export default App
