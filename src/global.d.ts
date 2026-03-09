type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition

interface BrowserSpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start: () => void
  stop: () => void
}

interface BrowserSpeechRecognitionEvent {
  results: ArrayLike<{
    0: {
      transcript: string
    }
    isFinal: boolean
    length: number
  }>
}

interface Window {
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor
  SpeechRecognition?: BrowserSpeechRecognitionConstructor
}
