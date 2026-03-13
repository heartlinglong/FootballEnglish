export type Difficulty = '初级' | '中级' | '高级'

export type Scene =
  | 'welcome'
  | 'characters'
  | 'dashboard'
  | 'gameplay'
  | 'complete'
  | 'workshop'
  | 'review'
  | 'parent'
  | 'parentSettings'
  | 'api'

export type CharacterId = 'bear' | 'rabbit' | 'cat'

export type BackgroundId = 'sunny' | 'rainy' | 'starry'

export type WordEntry = {
  id: string
  english: string
  chinese: string
  level: Difficulty
  category: string
  phonetic?: string
  exampleSentence?: string
  enabled: boolean
}

export type LevelDefinition = {
  id: string
  number: number
  difficulty: Difficulty
  wordCount: number
  title: string
  subtitle: string
  theme: string
  background: BackgroundId
}

export type CharacterOption = {
  id: CharacterId
  name: string
  englishName: string
  emoji: string
  accent: string
  description: string
  imageUrl?: string
}

export type LibraryProgressEntry = {
  seen: number
  correct: number
  wrong: number
}

export type WrongWordEntry = {
  wordId: string
  english: string
  chinese: string
  count: number
  lastSeen: string
  level: Difficulty
}

export type LevelHistoryEntry = {
  id: string
  levelId: string
  accuracy: number
  durationSeconds: number
  starsEarned: number
  completedAt: string
  wrongWords: string[]
}

export type ParentSettings = {
  difficulty: Difficulty
  dailyLimit: number
  reviewEnabled: boolean
  parentPassword: string
  sharingEnabled: boolean
}

export type ApiValidationState = 'idle' | 'checking' | 'success' | 'error'

export type ApiConfig = {
  volcengine: {
    appId: string
    accessKey: string
    secretKey: string
    status: ApiValidationState
    message: string
  }
  feishu: {
    appId: string
    appSecret: string
    tableLink: string
    status: ApiValidationState
    message: string
  }
  lastSyncAt?: string
  lastSyncSummary?: string
}

export type WorkshopBlockType =
  | 'rectangle'
  | 'square'
  | 'triangle'
  | 'oval'
  | 'roof'
  | 'window'
  | 'door'
  | 'chimney'

export type WorkshopBlock = {
  id: string
  type: WorkshopBlockType
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scale: number
  color: string
  label: string
}

export type WorkshopCreation = {
  id: string
  name: string
  savedAt: string
  imageData: string
  blocks: WorkshopBlock[]
}

export type FeedbackEntry = {
  id: string
  text: string
  createdAt: string
}

export type MicrophoneStatus =
  | 'unknown'
  | 'granted'
  | 'prompt'
  | 'denied'
  | 'unsupported'

export type AppState = {
  scene: Scene
  selectedCharacter?: CharacterId
  currentLevel: number
  completedLevels: string[]
  stars: number
  unlockedBackgrounds: BackgroundId[]
  settings: ParentSettings
  apiConfig: ApiConfig
  wordBank: WordEntry[]
  libraryProgress: Record<string, LibraryProgressEntry>
  wrongWords: WrongWordEntry[]
  levelHistory: LevelHistoryEntry[]
  workshopBlocks: WorkshopBlock[]
  workshopCreations: WorkshopCreation[]
  usageTodayMinutes: number
  usageWeekMinutes: number
  feedbackMessages: FeedbackEntry[]
  microphoneStatus: MicrophoneStatus
}
