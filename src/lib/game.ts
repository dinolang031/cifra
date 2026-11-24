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

export interface TimedQuestion {
  position: number
  questionId: string
  question: string
  itemName: string
  category: string
  unit: string
  location: string
  outcome: 'active' | 'answered' | 'timed_out'
  startedAt: string
  deadlineAt: string
  serverNow: string | null
  guess: number | null
  actualPrice: number | null
  score: number | null
  explanation: string | null
}

export interface TimedDailyProgress {
  date: string
  challengeId: string | null
  ruleset: 'timed-v1' | 'guest-timed-v1'
  isDemo: boolean
  questions: TimedQuestion[]
  guestQuestionIds: string[] | null
  serverRoundTripMs: number
  completed: boolean
  updatedAt: number
}

export interface HistoryEntry { date: string; score: number; accuracy: number | null; exact: number }
export interface QuestionHistoryEntry { date: string; questionIds: string[] }
export interface AppState {
  version: number
  daily: DailyProgress
  timedDaily: TimedDailyProgress | null
  archivedDaily: DailyProgress[]
  archivedTimedDaily: TimedDailyProgress[]
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

export const TIMED_QUESTION_DURATION_MS = 20_000

export function createGuestTimedDaily(
  daily: DailyProgress,
  isDemo: boolean,
  now = Date.now(),
): TimedDailyProgress {
  const firstQuestion = createGuestTimedQuestion(daily.questionIds[0], 1, now)
  return {
    date: daily.date,
    challengeId: daily.challengeId,
    ruleset: 'guest-timed-v1',
    isDemo,
    questions: [firstQuestion],
    guestQuestionIds: [...daily.questionIds],
    serverRoundTripMs: 0,
    completed: false,
    updatedAt: now,
  }
}

export function createGuestTimedQuestion(questionId: string, position: number, now = Date.now()): TimedQuestion {
  const question = getQuestions([questionId])[0]
  if (!question) throw new Error('Timed guest question is unavailable.')
  return {
    position,
    questionId: question.id,
    question: question.question,
    itemName: question.itemName,
    category: question.category,
    unit: question.unit,
    location: question.location,
    outcome: 'active',
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + TIMED_QUESTION_DURATION_MS).toISOString(),
    serverNow: null,
    guess: null,
    actualPrice: null,
    score: null,
    explanation: null,
  }
}

export function startGuestTimedQuestion(progress: TimedDailyProgress, now = Date.now()): TimedDailyProgress {
  const previous = progress.questions[progress.questions.length - 1]
  const position = progress.questions.length + 1
  if (progress.ruleset !== 'guest-timed-v1' || !previous || previous.outcome === 'active'
    || position > 5 || !progress.guestQuestionIds || progress.guestQuestionIds.length !== 5) {
    throw new Error('The next guest question cannot be started yet.')
  }
  return {
    ...progress,
    questions: [...progress.questions, createGuestTimedQuestion(progress.guestQuestionIds[position - 1], position, now)],
    updatedAt: now,
  }
}

export function resolveGuestTimedAnswer(
  progress: TimedDailyProgress,
  position: number,
  guess: number,
  now = Date.now(),
): TimedDailyProgress {
  const question = progress.questions[position - 1]
  if (progress.ruleset !== 'guest-timed-v1' || !question || question.position !== position
    || question.outcome !== 'active' || now >= Date.parse(question.deadlineAt)) {
    throw new Error('This timed guest question is no longer accepting answers.')
  }
  const actualPrice = getQuestions([question.questionId])[0]?.actualPrice
  if (actualPrice === undefined) throw new Error('Timed guest question price is unavailable.')
  return {
    ...progress,
    questions: progress.questions.map((current, index) => index === position - 1
      ? { ...current, outcome: 'answered', guess, actualPrice, score: scoreGuess(guess, actualPrice), explanation: getQuestions([current.questionId])[0].explanation }
      : current),
    updatedAt: now,
  }
}

export function resolveGuestTimedTimeout(
  progress: TimedDailyProgress,
  position: number,
  now = Date.now(),
): TimedDailyProgress {
  const question = progress.questions[position - 1]
  if (progress.ruleset !== 'guest-timed-v1' || !question || question.position !== position
    || question.outcome !== 'active' || now < Date.parse(question.deadlineAt)) {
    throw new Error('This timed guest question has not expired.')
  }
  const localQuestion = getQuestions([question.questionId])[0]
  if (!localQuestion) throw new Error('Timed guest question price is unavailable.')
  return {
    ...progress,
    questions: progress.questions.map((current, index) => index === position - 1
      ? { ...current, outcome: 'timed_out', guess: null, actualPrice: localQuestion.actualPrice, score: 0, explanation: localQuestion.explanation }
      : current),
    updatedAt: now,
  }
}

export function completeGuestTimedDaily(state: AppState, progress: TimedDailyProgress, now = Date.now()): AppState {
  if (progress.ruleset !== 'guest-timed-v1' || progress.questions.length !== 5
    || progress.questions.some(question => question.outcome === 'active'
      || question.actualPrice === null || question.score === null)) {
    throw new Error('All five timed guest questions must be resolved before completion.')
  }
  if (state.daily.completed && state.daily.date === progress.date) {
    return { ...state, timedDaily: { ...progress, completed: true, updatedAt: now } }
  }
  if (!progress.guestQuestionIds || progress.guestQuestionIds.length !== 5) {
    throw new Error('Timed guest question order is unavailable.')
  }

  const guesses = progress.questions.map(question => question.guess)
  const scores = progress.questions.map(question => question.score)
  const actualPrices = progress.questions.map(question => question.actualPrice as number)
  const total = scores.reduce<number>((sum, score) => sum + (score ?? 0), 0)
  const exact = progress.questions.filter(question => question.outcome === 'answered'
    && question.guess === question.actualPrice).length
  const answered = progress.questions.filter(question => question.outcome === 'answered')
  const averageError = answered.length
    ? answered.reduce((sum, question) => sum + Math.abs((question.guess ?? 0) - (question.actualPrice ?? 0))
      / (question.actualPrice ?? 1), 0) / answered.length * 100
    : null
  const last = state.history[state.history.length - 1]
  const currentStreak = calculateStreak(last?.date ?? null, progress.date, state.currentStreak)
  const history = state.history.some(entry => entry.date === progress.date)
    ? state.history
    : [...state.history, {
        date: progress.date,
        score: total,
        accuracy: averageError === null ? null : 100 - Math.min(100, averageError),
        exact,
      }].slice(-30)
  const completedDaily: DailyProgress = {
    ...state.daily,
    date: progress.date,
    challengeId: progress.challengeId,
    questionIds: [...progress.guestQuestionIds],
    actualPrices,
    guesses,
    scores,
    index: 4,
    revealed: false,
    completed: true,
    updatedAt: now,
  }

  return {
    ...state,
    version: 3,
    daily: completedDaily,
    timedDaily: { ...progress, completed: true, updatedAt: now },
    currentStreak,
    bestStreak: Math.max(state.bestStreak, currentStreak),
    totalGames: history.length === state.history.length ? state.totalGames : state.totalGames + 1,
    totalPoints: history.length === state.history.length ? state.totalPoints : state.totalPoints + total,
    bestScore: Math.max(state.bestScore, total),
    exactGuesses: history.length === state.history.length ? state.exactGuesses : state.exactGuesses + exact,
    history,
  }
}

export function remainingTimerMs(deadlineMs: number, nowMs: number) {
  return Math.max(0, deadlineMs - nowMs)
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

function normalizeTimedDaily(value: unknown): TimedDailyProgress | null {
  if (!value || typeof value !== 'object') return null
  const progress = value as Partial<TimedDailyProgress>
  const timedQuestions = Array.isArray(progress.questions) ? progress.questions : null
  if (typeof progress.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(progress.date)
    || (progress.ruleset !== 'timed-v1' && progress.ruleset !== 'guest-timed-v1')
    || !timedQuestions || timedQuestions.length > 5
    || !Number.isFinite(progress.serverRoundTripMs) || (progress.serverRoundTripMs ?? -1) < 0
    || !timedQuestions.every((question, index) => question && question.position === index + 1
      && typeof question.questionId === 'string' && typeof question.question === 'string'
      && typeof question.itemName === 'string' && typeof question.category === 'string'
      && typeof question.unit === 'string' && typeof question.location === 'string'
      && ['active', 'answered', 'timed_out'].includes(question.outcome)
      && typeof question.startedAt === 'string' && Number.isFinite(Date.parse(question.startedAt))
      && typeof question.deadlineAt === 'string' && Number.isFinite(Date.parse(question.deadlineAt))
      && Date.parse(question.deadlineAt) - Date.parse(question.startedAt) === TIMED_QUESTION_DURATION_MS
      && (question.serverNow === null || (typeof question.serverNow === 'string' && Number.isFinite(Date.parse(question.serverNow))))
      && (question.guess === null || (typeof question.guess === 'number' && Number.isFinite(question.guess) && question.guess > 0))
      && (question.actualPrice === null || (typeof question.actualPrice === 'number' && Number.isFinite(question.actualPrice) && question.actualPrice > 0))
      && (question.score === null || (Number.isInteger(question.score) && question.score >= 0 && question.score <= 1000))
      && (question.explanation === null || typeof question.explanation === 'string')
      && (question.outcome === 'active'
        ? question.guess === null && question.actualPrice === null && question.score === null && question.explanation === null
        : question.outcome === 'answered'
          ? question.guess !== null && question.actualPrice !== null && question.score !== null
          : question.guess === null && question.actualPrice !== null && question.score === 0))
    || (progress.ruleset === 'timed-v1' && progress.guestQuestionIds !== null)
    || (progress.guestQuestionIds !== null && progress.guestQuestionIds !== undefined && (!Array.isArray(progress.guestQuestionIds)
      || progress.guestQuestionIds.length !== 5 || progress.guestQuestionIds.some(id => typeof id !== 'string')))
    || (progress.ruleset === 'guest-timed-v1' && (!progress.guestQuestionIds
      || getQuestions(progress.guestQuestionIds).length !== 5 || new Set(progress.guestQuestionIds).size !== 5))
    || timedQuestions.filter(question => question.outcome === 'active').length > 1
    || timedQuestions.some((question, index) => question.outcome === 'active' && index !== timedQuestions.length - 1)) {
    return null
  }
  if (progress.completed && (timedQuestions.length !== 5 || timedQuestions.some(question => question.outcome === 'active'))) {
    return null
  }

  return {
    date: progress.date,
    challengeId: typeof progress.challengeId === 'string' ? progress.challengeId : null,
    ruleset: progress.ruleset,
    isDemo: Boolean(progress.isDemo),
    questions: timedQuestions.map(question => ({ ...question })),
    guestQuestionIds: progress.guestQuestionIds ? [...progress.guestQuestionIds] : null,
    serverRoundTripMs: progress.serverRoundTripMs ?? 0,
    completed: Boolean(progress.completed),
    updatedAt: typeof progress.updatedAt === 'number' ? progress.updatedAt : 0,
  }
}

function defaultState(today: string): AppState {
  return {
    version: 3,
    daily: newDaily(today),
    timedDaily: null,
    archivedDaily: [],
    archivedTimedDaily: [],
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
    if ((saved.version !== 1 && saved.version !== 2 && saved.version !== 3) || !daily) return fallback

    const archived = (Array.isArray(saved.archivedDaily) ? saved.archivedDaily : [])
      .map(normalizeDaily)
      .filter((entry): entry is DailyProgress => Boolean(entry))
    const archivedTimed = (Array.isArray(saved.archivedTimedDaily) ? saved.archivedTimedDaily : [])
      .map(normalizeTimedDaily)
      .filter((entry): entry is TimedDailyProgress => Boolean(entry))
    const timedDaily = normalizeTimedDaily(saved.timedDaily)
    const questionHistory = Array.isArray(saved.questionHistory)
      ? saved.questionHistory.filter(entry=>entry&&/^\d{4}-\d{2}-\d{2}$/.test(entry.date)&&Array.isArray(entry.questionIds))
        .map(entry=>({date:entry.date,questionIds:entry.questionIds.filter(id=>typeof id==='string'&&questions.some(question=>question.id===id))}))
        .filter(entry=>entry.questionIds.length===5)
      : []
    if (daily.date !== today && (daily.completed||daily.guesses.some(guess => guess !== null))) {
      if(!questionHistory.some(entry=>entry.date===daily.date))questionHistory.push({date:daily.date,questionIds:daily.questionIds})
      if(!daily.completed)archived.push(daily)
    }
    if (timedDaily && timedDaily.date !== today) archivedTimed.push(timedDaily)
    const recentQuestionHistory=questionHistory.sort((a,b)=>a.date.localeCompare(b.date)).slice(-30)
    const currentDaily = daily.date === today ? daily : newDaily(today,undefined,null,recentQuestionHistory)
    const history = Array.isArray(saved.history) ? saved.history.filter(entry =>
      entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      && Number.isFinite(entry.score) && (entry.accuracy === null || Number.isFinite(entry.accuracy)) && Number.isFinite(entry.exact),
    ) : []

    return {
      version: 3,
      daily: currentDaily,
      timedDaily: timedDaily?.date === today ? timedDaily : null,
      archivedDaily: archived.filter(entry => !entry.completed).slice(-30),
      archivedTimedDaily: archivedTimed.filter(entry => !entry.completed).slice(-30),
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
  const timedQuestionIds=state.timedDaily?.date===state.daily.date?state.timedDaily.questions.map(question=>question.questionId):[]
  const hasPlayedChallenge=state.daily.completed||state.daily.guesses.some(guess=>guess!==null)||timedQuestionIds.length>0
  const questionHistory=hasPlayedChallenge
    ?[...state.questionHistory.filter(entry=>entry.date!==state.daily.date),{date:state.daily.date,questionIds:timedQuestionIds.length?timedQuestionIds:state.daily.questionIds}].sort((a,b)=>a.date.localeCompare(b.date)).slice(-30)
    :state.questionHistory
  const archivedDaily = !state.daily.completed && state.daily.guesses.some(guess => guess !== null)
    ? [...state.archivedDaily, state.daily].slice(-30)
    : state.archivedDaily
  const archivedTimedDaily = state.timedDaily && !state.timedDaily.completed
    ? [...state.archivedTimedDaily, state.timedDaily].slice(-30)
    : state.archivedTimedDaily
  return {
    ...state,
    version: 3,
    daily: newDaily(today, questionIds??selectDailyQuestions(today,questionHistory), challengeId, questionHistory),
    timedDaily: null,
    archivedDaily,
    archivedTimedDaily,
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
