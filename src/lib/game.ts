import { questions, type Question } from '../data/questions'

export interface DailyProgress {
  date: string
  challengeId: string | null
  questionIds: string[]
  actualPrices: number[]
  index: number
  guesses: (number | null)[]
  scores: (number | null)[]
  revealed: boolean
  completed: boolean
  updatedAt: number
}

export interface HistoryEntry { date: string; score: number; accuracy: number; exact: number }
export interface QuestionHistoryEntry { date: string; questionIds: string[] }
export interface AppState {
  version: number
  daily: DailyProgress
  archivedDaily: DailyProgress[]
  history: HistoryEntry[]
  questionHistory: QuestionHistoryEntry[]
  currentStreak: number
  bestStreak: number
  totalPoints: number
  bestScore: number
  totalGames: number
  exactGuesses: number
}

export const STORAGE_KEY = 'cifra-progress-v1'
export const guestStorageKey = STORAGE_KEY
export const userStorageKey = (userId: string) => `${STORAGE_KEY}:user:${userId}`

export function croatiaDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zagreb',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find(part => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function millisecondsUntilNextCroatiaDay(now = new Date()) {
  const today = croatiaDateKey(now)
  let low = now.getTime()
  let high = low + 36 * 60 * 60 * 1000
  while (croatiaDateKey(new Date(high)) === today) high += 12 * 60 * 60 * 1000
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2)
    if (croatiaDateKey(new Date(middle)) === today) low = middle
    else high = middle
  }
  return high - now.getTime()
}

export function formatCroatianDayCount(value: number) {
  const remainder100 = Math.abs(value) % 100
  const remainder10 = remainder100 % 10
  const unit = remainder10 === 1 && remainder100 !== 11 ? 'dan'
    : remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14) ? 'dana'
      : 'dana'
  return `${value} ${unit}`
}

export function formatCroatianDate(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Intl.DateTimeFormat('hr-HR', { day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, day))
}

export function formatPrice(value: number) {
  return new Intl.NumberFormat('hr-HR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function parseGuess(raw: string) {
  const trimmed = raw.trim()
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(trimmed)) return null
  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) && value > 0 && value <= 1_000_000_000 ? value : null
}

export function scoreGuess(guess: number, actual: number) {
  const relativeError = Math.abs(guess - actual) / actual
  return Math.max(0, Math.min(1000, Math.round(1000 * Math.exp(-4 * relativeError))))
}

function hash(input: string) {
  let result = 2166136261
  for (let index = 0; index < input.length; index++) {
    result ^= input.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}

function mulberry32(seed: number) {
  return () => {
    let value = seed += 0x6D2B79F5
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function selectDailyQuestions(date: string, questionHistory: QuestionHistoryEntry[] = []): string[] {
  const random = mulberry32(hash(`cifra-${date}`))
  const previousDate=questionHistory.reduce((latest,entry)=>entry.date>latest?entry.date:latest,'')
  const previousIds=new Set(questionHistory.find(entry=>entry.date===previousDate)?.questionIds??[])
  const alternatives=questions.filter(question=>!previousIds.has(question.id))
  const candidates=alternatives.length>=5?alternatives:questions
  const appearances=new Map<string,number>()
  const lastAppearance=new Map<string,string>()
  for(const entry of questionHistory){
    for(const id of entry.questionIds){
      appearances.set(id,(appearances.get(id)??0)+1)
      lastAppearance.set(id,entry.date)
    }
  }
  const randomOrder=new Map(candidates.map(question=>[question.id,random()]))
  const ranked=[...candidates].sort((a,b)=>
    (appearances.get(a.id)??0)-(appearances.get(b.id)??0)
    ||(lastAppearance.get(a.id)??'').localeCompare(lastAppearance.get(b.id)??'')
    ||(randomOrder.get(a.id)??0)-(randomOrder.get(b.id)??0),
  )

  const selected: Question[] = []
  const usedCategories = new Set<string>()
  for (const question of ranked) {
    if (selected.length === 5) break
    if (!usedCategories.has(question.category)) {
      selected.push(question)
      usedCategories.add(question.category)
    }
  }
  for (const question of ranked) {
    if (selected.length === 5) break
    if (!selected.includes(question)) selected.push(question)
  }
  return selected.slice(0, 5).map(question => question.id)
}

export function getQuestions(ids: string[]) {
  return ids.map(id => questions.find(question => question.id === id))
    .filter((question): question is Question => Boolean(question))
}

export function newDaily(date: string, questionIds?: string[], challengeId: string | null = null, questionHistory: QuestionHistoryEntry[] = []): DailyProgress {
  const selectedQuestionIds=questionIds??selectDailyQuestions(date,questionHistory)
  return {
    date,
    challengeId,
    questionIds: [...selectedQuestionIds],
    actualPrices: getQuestions(selectedQuestionIds).map(question => question.actualPrice),
    index: 0,
    guesses: Array(5).fill(null),
    scores: Array(5).fill(null),
    revealed: false,
    completed: false,
    updatedAt: Date.now(),
  }
}

function normalizeDaily(value: unknown): DailyProgress | null {
  if (!value || typeof value !== 'object') return null
  const daily = value as Partial<DailyProgress>
  if (typeof daily.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(daily.date)
    || !Array.isArray(daily.questionIds) || daily.questionIds.length !== 5
    || daily.questionIds.some(id => typeof id !== 'string')
    || getQuestions(daily.questionIds).length !== 5
    || new Set(daily.questionIds).size !== 5
    || !Array.isArray(daily.guesses) || daily.guesses.length !== 5
    || !Array.isArray(daily.scores) || daily.scores.length !== 5
    || !Number.isInteger(daily.index) || (daily.index ?? -1) < 0 || (daily.index ?? 5) > 4
    || daily.guesses.some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
    || daily.scores.some(value => value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000))) {
    return null
  }

  return {
    date: daily.date,
    challengeId: typeof daily.challengeId === 'string' ? daily.challengeId : null,
    questionIds: [...daily.questionIds],
    actualPrices: Array.isArray(daily.actualPrices) && daily.actualPrices.length === 5
      && daily.actualPrices.every(price => typeof price === 'number' && Number.isFinite(price) && price > 0)
      ? [...daily.actualPrices]
      : getQuestions(daily.questionIds).map(question => question.actualPrice),
    index: daily.index ?? 0,
    guesses: [...daily.guesses],
    scores: [...daily.scores],
    revealed: Boolean(daily.revealed),
    completed: Boolean(daily.completed),
    updatedAt: typeof daily.updatedAt === 'number' ? daily.updatedAt : 0,
  }
}

function defaultState(today: string): AppState {
  return {
    version: 2,
    daily: newDaily(today),
    archivedDaily: [],
    history: [],
    questionHistory: [],
    currentStreak: 0,
    bestStreak: 0,
    totalPoints: 0,
    bestScore: 0,
    totalGames: 0,
    exactGuesses: 0,
  }
}

export function loadState(storageKey = STORAGE_KEY, today = croatiaDateKey()): AppState {
  const fallback = defaultState(today)
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return fallback
    const saved = JSON.parse(raw) as Partial<AppState>
    const daily = normalizeDaily(saved.daily)
    if ((saved.version !== 1 && saved.version !== 2) || !daily) return fallback

    const archived = (Array.isArray(saved.archivedDaily) ? saved.archivedDaily : [])
      .map(normalizeDaily)
      .filter((entry): entry is DailyProgress => Boolean(entry))
    const questionHistory = Array.isArray(saved.questionHistory)
      ? saved.questionHistory.filter(entry=>entry&&/^\d{4}-\d{2}-\d{2}$/.test(entry.date)&&Array.isArray(entry.questionIds))
        .map(entry=>({date:entry.date,questionIds:entry.questionIds.filter(id=>typeof id==='string'&&questions.some(question=>question.id===id))}))
        .filter(entry=>entry.questionIds.length===5)
      : []
    if (daily.date !== today && (daily.completed||daily.guesses.some(guess => guess !== null))) {
      if(!questionHistory.some(entry=>entry.date===daily.date))questionHistory.push({date:daily.date,questionIds:daily.questionIds})
      if(!daily.completed)archived.push(daily)
    }
    const recentQuestionHistory=questionHistory.sort((a,b)=>a.date.localeCompare(b.date)).slice(-30)
    const currentDaily = daily.date === today ? daily : newDaily(today,undefined,null,recentQuestionHistory)
    const history = Array.isArray(saved.history) ? saved.history.filter(entry =>
      entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      && Number.isFinite(entry.score) && Number.isFinite(entry.accuracy) && Number.isFinite(entry.exact),
    ) : []

    return {
      version: 2,
      daily: currentDaily,
      archivedDaily: archived.filter(entry => !entry.completed).slice(-30),
      history,
      questionHistory: recentQuestionHistory,
      currentStreak: getActiveStreak(
        history.length ? history[history.length - 1].date : null,
        today,
        typeof saved.currentStreak === 'number' ? saved.currentStreak : 0,
      ),
      bestStreak: typeof saved.bestStreak === 'number' ? saved.bestStreak : 0,
      totalPoints: typeof saved.totalPoints === 'number' ? saved.totalPoints : 0,
      bestScore: typeof saved.bestScore === 'number' ? saved.bestScore : 0,
      totalGames: typeof saved.totalGames === 'number' ? saved.totalGames : 0,
      exactGuesses: typeof saved.exactGuesses === 'number' ? saved.exactGuesses : 0,
    }
  } catch {
    return fallback
  }
}

export function saveState(state: AppState, storageKey = STORAGE_KEY) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function rolloverDaily(state: AppState, today: string, questionIds?: string[], challengeId: string | null = null) {
  if (state.daily.date === today) return state
  const questionHistory=state.daily.completed||state.daily.guesses.some(guess=>guess!==null)
    ?[...state.questionHistory.filter(entry=>entry.date!==state.daily.date),{date:state.daily.date,questionIds:state.daily.questionIds}].sort((a,b)=>a.date.localeCompare(b.date)).slice(-30)
    :state.questionHistory
  const archivedDaily = !state.daily.completed && state.daily.guesses.some(guess => guess !== null)
    ? [...state.archivedDaily, state.daily].slice(-30)
    : state.archivedDaily
  return {
    ...state,
    daily: newDaily(today, questionIds??selectDailyQuestions(today,questionHistory), challengeId, questionHistory),
    archivedDaily,
    questionHistory,
    currentStreak: getActiveStreak(
      state.history.length ? state.history[state.history.length - 1].date : null,
      today,
      state.currentStreak,
    ),
  }
}

export function daysBetween(a: string, b: string) {
  const first = a.split('-').map(Number)
  const second = b.split('-').map(Number)
  const firstUtc = Date.UTC(first[0], first[1] - 1, first[2])
  const secondUtc = Date.UTC(second[0], second[1] - 1, second[2])
  return Math.round((secondUtc - firstUtc) / 86400000)
}

export function getActiveStreak(lastDate: string | null, today: string, currentStreak: number) {
  if (!lastDate) return 0
  const elapsed = daysBetween(lastDate, today)
  return elapsed >= 0 && elapsed <= 1 ? currentStreak : 0
}

export function challengeNumber(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const value = Date.UTC(year, month - 1, day) - Date.UTC(2026, 0, 1)
  return Math.max(1, Math.floor(value / 86400000) + 1)
}

export function calculateStreak(lastDate: string | null, today: string, currentStreak: number) {
  if (lastDate === today) return currentStreak
  if (!lastDate) return 1
  return daysBetween(lastDate, today) === 1 ? currentStreak + 1 : 1
}
