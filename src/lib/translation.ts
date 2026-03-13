function cleanTranslation(text: string) {
  return text
    .replace(/[“”"]/g, '')
    .replace(/[，。！？、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function extractGoogleTranslation(payload: unknown) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    return null
  }

  const segments = payload[0]
    .map((item) => (Array.isArray(item) && typeof item[0] === 'string' ? item[0] : ''))
    .filter(Boolean)
    .join(' ')

  return segments ? cleanTranslation(segments) : null
}

async function requestGoogleTranslate(text: string) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'zh-CN',
    tl: 'en',
    dt: 't',
    q: text,
  })
  const response = await fetch(
    `https://translate.googleapis.com/translate_a/single?${params.toString()}`,
  )

  if (!response.ok) {
    throw new Error(`google:${response.status}`)
  }

  const payload = (await response.json()) as unknown
  return extractGoogleTranslation(payload)
}

async function requestMyMemoryTranslate(text: string) {
  const params = new URLSearchParams({
    q: text,
    langpair: 'zh-CN|en-US',
  })
  const response = await fetch(`https://api.mymemory.translated.net/get?${params.toString()}`)

  if (!response.ok) {
    throw new Error(`mymemory:${response.status}`)
  }

  const payload = (await response.json()) as {
    responseData?: {
      translatedText?: string
    }
  }
  const translatedText = payload.responseData?.translatedText
  return translatedText ? cleanTranslation(translatedText) : null
}

export async function translateChineseToEnglish(text: string) {
  const keyword = text.trim()
  if (!keyword) {
    return null
  }

  const providers = [requestGoogleTranslate, requestMyMemoryTranslate]

  for (const provider of providers) {
    try {
      const translated = await provider(keyword)
      if (translated && /[a-z]/i.test(translated) && !/[\u4e00-\u9fff]/.test(translated)) {
        return translated
      }
    } catch {
      continue
    }
  }

  return null
}
