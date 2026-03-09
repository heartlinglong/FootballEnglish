import { starterWords } from '../data/gameData'
import type { ApiConfig, AppState, ParentSettings } from '../types'

const APP_STATE_KEY = 'football-english-town-state'
const API_STATE_KEY = 'football-english-town-api-config'

const defaultSettings: ParentSettings = {
  difficulty: '初级',
  dailyLimit: 30,
  reviewEnabled: true,
  parentPassword: '',
  sharingEnabled: true,
}

const defaultApiConfig: ApiConfig = {
  volcengine: {
    appId: '',
    accessKey: '',
    secretKey: '',
    status: 'idle',
    message: '未验证',
  },
  feishu: {
    appId: '',
    appSecret: '',
    tableLink: '',
    status: 'idle',
    message: '未验证',
  },
}

export function createDefaultAppState(): AppState {
  return {
    scene: 'welcome',
    currentLevel: 1,
    completedLevels: [],
    stars: 0,
    unlockedBackgrounds: ['sunny'],
    settings: defaultSettings,
    apiConfig: defaultApiConfig,
    libraryProgress: Object.fromEntries(
      starterWords.map((word) => [word.id, { seen: 0, correct: 0, wrong: 0 }]),
    ),
    wrongWords: [],
    levelHistory: [],
    workshopBlocks: [],
    workshopCreations: [],
    usageTodayMinutes: 25,
    usageWeekMinutes: 135,
    feedbackMessages: [],
    microphoneStatus: 'unknown',
  }
}

function encodeSecureValue<T>(value: T) {
  return window.btoa(unescape(encodeURIComponent(JSON.stringify(value))))
}

function decodeSecureValue<T>(value: string) {
  return JSON.parse(decodeURIComponent(escape(window.atob(value)))) as T
}

export function loadAppState() {
  const defaults = createDefaultAppState()

  try {
    const rawState = window.localStorage.getItem(APP_STATE_KEY)
    const rawApiConfig = window.localStorage.getItem(API_STATE_KEY)

    const parsedState = rawState ? (JSON.parse(rawState) as Partial<AppState>) : {}
    const parsedApi = rawApiConfig ? decodeSecureValue<ApiConfig>(rawApiConfig) : defaults.apiConfig

    return {
      ...defaults,
      ...parsedState,
      settings: {
        ...defaults.settings,
        ...(parsedState.settings ?? {}),
      },
      apiConfig: {
        ...defaults.apiConfig,
        ...parsedApi,
        volcengine: {
          ...defaults.apiConfig.volcengine,
          ...(parsedApi?.volcengine ?? {}),
        },
        feishu: {
          ...defaults.apiConfig.feishu,
          ...(parsedApi?.feishu ?? {}),
        },
      },
      libraryProgress: {
        ...defaults.libraryProgress,
        ...(parsedState.libraryProgress ?? {}),
      },
    } satisfies AppState
  } catch {
    return defaults
  }
}

export function saveAppState(state: AppState) {
  const { apiConfig, ...rest } = state
  window.localStorage.setItem(APP_STATE_KEY, JSON.stringify(rest))
  window.localStorage.setItem(API_STATE_KEY, encodeSecureValue(apiConfig))
}
