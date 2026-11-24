import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { croatiaDateKey, getActiveStreak, type AppState, type HistoryEntry } from './game'

export interface CloudChallenge {
  challenge_id: string
  challenge_date: string
  question_ids: string[]
  is_demo: boolean
}

export interface CloudGameResult {
  result_id: string
  total_score: number
  question_scores: number[]
  exact_guesses: number
  current_streak: number
  best_streak: number
  duplicate: boolean
}

export interface CloudAnswerResult {
  question_position: number
  accepted_guess: number
  actual_price: number
  question_score: number
  duplicate: boolean
}

export interface CloudAttemptProgress {
  guesses: number[]
  question_scores: number[]
  actual_prices: number[]
  answered_count: number
}

export interface CloudGameplayMode {
  timed_enabled: boolean
  challenge_id: string
  challenge_date: string
  is_demo: boolean
  attempt_ruleset: 'untimed-v1' | 'timed-v1' | null
  has_result: boolean
}

export interface CloudTimedQuestion {
  question_position: number
  question_id: string
  question_text: string
  item_name: string
  category: string
  unit: string
  location: string
  outcome: 'active' | 'answered' | 'timed_out'
  started_at: string
  deadline_at: string
  server_now: string
  guess: number | null
  actual_price: number | null
  question_score: number | null
  explanation: string | null
  duplicate: boolean
}

export interface CloudTimedAttemptStart extends CloudTimedQuestion {
  attempt_token: string
}

export interface CloudTimedResult {
  result_id: string
  total_score: number
  question_scores: number[]
  guesses: (number | null)[]
  exact_guesses: number
  average_error_percent: number | null
  current_streak: number
  best_streak: number
  duplicate: boolean
}

export interface CloudSnapshot {
  currentStreak: number
  bestStreak: number
  totalGames: number
  totalPoints: number
  bestScore: number
  exactGuesses: number
  history: HistoryEntry[]
  todayResult: {
    challengeId: string
    guesses: (number | null)[]
    scores: number[]
  } | null
}

export async function fetchPublicTimedGameplayEnabled(): Promise<boolean> {
  if (!supabase) return false
  const { data, error } = await supabase.rpc('get_public_timed_gameplay_enabled')
  if (error) throw error
  return data === true
}

export async function fetchTodayGameplayMode(date: string): Promise<CloudGameplayMode> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('get_today_game_mode', {
    p_challenge_date: date,
  })
  if (error) throw error
  const mode = data?.[0]
  if (!mode) throw new Error('Poslužitelj nije vratio način igre za današnji izazov.')
  return mode
}

export async function startTimedDailyAttempt(date: string): Promise<CloudTimedAttemptStart> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('start_timed_daily_attempt', {
    p_challenge_date: date,
  })
  if (error) throw error
  const attempt = data?.[0]
  if (!attempt?.attempt_token) throw new Error('Poslužitelj nije otvorio vremenski pokušaj.')
  return attempt
}

export async function fetchTimedAttemptProgress(date: string): Promise<CloudTimedQuestion[]> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('get_timed_attempt_progress', {
    p_challenge_date: date,
  })
  if (error) throw error
  return data ?? []
}

export async function startTimedQuestion(
  date: string,
  position: number,
  attemptToken: string,
): Promise<CloudTimedQuestion> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('start_timed_question', {
    p_challenge_date: date,
    p_question_position: position,
    p_attempt_token: attemptToken,
  })
  if (error) throw error
  const question = data?.[0]
  if (!question) throw new Error('Poslužitelj nije pokrenuo sljedeće pitanje.')
  return question
}

export async function submitTimedAnswer(
  date: string,
  position: number,
  guess: number,
  attemptToken: string,
): Promise<CloudTimedQuestion> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('submit_timed_answer', {
    p_challenge_date: date,
    p_question_position: position,
    p_guess: guess,
    p_attempt_token: attemptToken,
  })
  if (error) throw error
  const answer = data?.[0]
  if (!answer) throw new Error('Poslužitelj nije potvrdio odgovor.')
  return answer
}

export async function expireTimedQuestion(
  date: string,
  position: number,
  attemptToken: string,
): Promise<CloudTimedQuestion> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('expire_timed_question', {
    p_challenge_date: date,
    p_question_position: position,
    p_attempt_token: attemptToken,
  })
  if (error) throw error
  const question = data?.[0]
  if (!question) throw new Error('Poslužitelj nije potvrdio istek vremena.')
  return question
}

export async function submitTimedResult(date: string, attemptToken: string): Promise<CloudTimedResult> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('submit_timed_daily_result', {
    p_challenge_date: date,
    p_attempt_token: attemptToken,
  })
  if (error) throw error
  const result = data?.[0]
  if (!result) throw new Error('Poslužitelj nije vratio završni rezultat.')
  return result
}

export async function fetchTodayChallenge(): Promise<CloudChallenge> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('get_today_challenge')
  if (error) throw error
  const challenge = data?.[0]
  if (!challenge || challenge.question_ids.length !== 5) {
    throw new Error('Današnji izazov još nije dostupan u Supabaseu.')
  }
  return challenge
}

export async function startDailyAttempt(date: string): Promise<string> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('start_daily_attempt', {
    p_challenge_date: date,
  })
  if (error) throw error
  const attempt = data?.[0]
  if (!attempt?.attempt_token) throw new Error('Poslužitelj nije otvorio pokušaj današnjeg izazova.')
  return attempt.attempt_token
}

export async function fetchDailyAttemptProgress(date: string): Promise<CloudAttemptProgress | null> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('get_daily_attempt_progress', {
    p_challenge_date: date,
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function submitDailyAnswer(
  date: string,
  position: number,
  guess: number,
  attemptToken: string,
): Promise<CloudAnswerResult> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('submit_daily_answer', {
    p_challenge_date: date,
    p_question_position: position,
    p_guess: guess,
    p_attempt_token: attemptToken,
  })
  if (error) throw error
  const answer = data?.[0]
  if (!answer) throw new Error('Poslužitelj nije potvrdio procjenu.')
  return answer
}

export async function submitResult(date: string, guesses: number[], attemptToken: string): Promise<CloudGameResult> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const { data, error } = await supabase.rpc('submit_daily_result', {
    p_challenge_date: date,
    p_guesses: guesses,
    p_attempt_token: attemptToken,
  })
  if (error) throw error
  const result = data?.[0]
  if (!result) throw new Error('Poslužitelj nije vratio rezultat.')
  return result
}

export async function fetchCloudSnapshot(user: User): Promise<CloudSnapshot> {
  if (!supabase) throw new Error('Supabase nije konfiguriran.')
  const [statsResponse, historyResponse] = await Promise.all([
    supabase.from('user_statistics').select('*').eq('user_id', user.id).maybeSingle(),
    supabase.from('game_results').select('challenge_id,challenge_date,total_score,exact_guesses,average_error_percent,guesses,question_scores')
      .eq('user_id', user.id).order('challenge_date', { ascending: false }).limit(30),
  ])
  if (statsResponse.error) throw statsResponse.error
  if (historyResponse.error) throw historyResponse.error

  const results = historyResponse.data ?? []
  const latestResult = results[0]
  const history: HistoryEntry[] = [...results].reverse().map((result) => ({
    date: result.challenge_date,
    score: result.total_score,
    exact: result.exact_guesses,
    accuracy: result.average_error_percent === null
      ? null
      : Math.max(0, 100 - Number(result.average_error_percent)),
  }))

  const stats = statsResponse.data
  return {
    currentStreak: getActiveStreak(stats?.last_completed_date ?? null, croatiaDateKey(), stats?.current_streak ?? 0),
    bestStreak: stats?.best_streak ?? 0,
    totalGames: stats?.total_games ?? 0,
    totalPoints: stats?.total_points ?? 0,
    bestScore: stats?.best_score ?? 0,
    exactGuesses: stats?.exact_guesses ?? 0,
    history,
    todayResult: latestResult?.challenge_date === croatiaDateKey()
      ? {
          challengeId: latestResult.challenge_id,
          guesses: latestResult.guesses,
          scores: latestResult.question_scores,
        }
      : null,
  }
}

export function mergeCloudSnapshot(state: AppState, snapshot: CloudSnapshot): AppState {
  return {
    ...state,
    currentStreak: snapshot.currentStreak,
    bestStreak: snapshot.bestStreak,
    totalGames: snapshot.totalGames,
    totalPoints: snapshot.totalPoints,
    bestScore: snapshot.bestScore,
    exactGuesses: snapshot.exactGuesses,
    history: snapshot.history,
  }
}
