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
    guesses: number[]
    scores: number[]
  } | null
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
    accuracy: Math.max(0, 100 - Number(result.average_error_percent)),
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
