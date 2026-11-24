export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; username: string; display_name: string | null; avatar_url: string | null; created_at: string; updated_at: string }
        Insert: { id: string; username?: string; display_name?: string | null; avatar_url?: string | null }
        Update: { username?: string; display_name?: string | null; avatar_url?: string | null; updated_at?: string }
        Relationships: []
      }
      questions: {
        Row: { id: string; question: string; item_name: string; category: string; actual_price: number; currency: string; unit: string; location: string; image_url: string | null; explanation: string | null; verification_status: string; is_demo: boolean; active: boolean }
        Insert: never
        Update: never
        Relationships: []
      }
      daily_challenges: {
        Row: { id: string; challenge_date: string; published: boolean; is_demo: boolean; created_at: string; published_at: string | null }
        Insert: never
        Update: never
        Relationships: []
      }
      challenge_questions: {
        Row: { challenge_id: string; question_id: string; position: number }
        Insert: never
        Update: never
        Relationships: []
      }
      challenge_attempt_answers: {
        Row: { attempt_id: string; question_position: number; guess: number; score: number; answered_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      challenge_attempt_questions: {
        Row: { attempt_id: string; question_position: number; status: 'active' | 'answered' | 'timed_out'; started_at: string; deadline_at: string; resolved_at: string | null; guess: number | null; score: number | null }
        Insert: never
        Update: never
        Relationships: []
      }
      game_results: {
        Row: { id: string; user_id: string; challenge_id: string; challenge_date: string; total_score: number; guesses: (number | null)[]; question_scores: number[]; exact_guesses: number; average_error_percent: number | null; completed_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      user_statistics: {
        Row: { user_id: string; current_streak: number; best_streak: number; last_completed_date: string | null; total_games: number; total_points: number; best_score: number; exact_guesses: number; updated_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      get_public_timed_gameplay_enabled: { Args: Record<string, never>; Returns: boolean }
      get_today_challenge: { Args: Record<string, never>; Returns: { challenge_id: string; challenge_date: string; question_ids: string[]; is_demo: boolean }[] }
      get_today_game_mode: { Args: { p_challenge_date: string }; Returns: { timed_enabled: boolean; challenge_id: string; challenge_date: string; is_demo: boolean; attempt_ruleset: 'untimed-v1' | 'timed-v1' | null; has_result: boolean }[] }
      start_daily_attempt: { Args: { p_challenge_date: string }; Returns: { attempt_token: string; challenge_id: string; challenge_date: string }[] }
      get_daily_attempt_progress: { Args: { p_challenge_date: string }; Returns: { guesses: number[]; question_scores: number[]; actual_prices: number[]; answered_count: number }[] }
      submit_daily_answer: { Args: { p_challenge_date: string; p_question_position: number; p_guess: number; p_attempt_token: string }; Returns: { question_position: number; accepted_guess: number; actual_price: number; question_score: number; duplicate: boolean }[] }
      submit_daily_result: { Args: { p_challenge_date: string; p_guesses: number[]; p_attempt_token: string }; Returns: { result_id: string; total_score: number; question_scores: number[]; exact_guesses: number; average_error_percent: number; current_streak: number; best_streak: number; duplicate: boolean }[] }
      start_timed_daily_attempt: { Args: { p_challenge_date: string }; Returns: { attempt_token: string; question_position: number; question_id: string; question_text: string; item_name: string; category: string; unit: string; location: string; outcome: 'active' | 'answered' | 'timed_out'; started_at: string; deadline_at: string; server_now: string; guess: number | null; actual_price: number | null; question_score: number | null; explanation: string | null; duplicate: boolean }[] }
      get_timed_attempt_progress: { Args: { p_challenge_date: string }; Returns: { question_position: number; question_id: string; question_text: string; item_name: string; category: string; unit: string; location: string; outcome: 'active' | 'answered' | 'timed_out'; started_at: string; deadline_at: string; server_now: string; guess: number | null; actual_price: number | null; question_score: number | null; explanation: string | null; duplicate: boolean }[] }
      start_timed_question: { Args: { p_challenge_date: string; p_question_position: number; p_attempt_token: string }; Returns: { question_position: number; question_id: string; question_text: string; item_name: string; category: string; unit: string; location: string; outcome: 'active' | 'answered' | 'timed_out'; started_at: string; deadline_at: string; server_now: string; guess: number | null; actual_price: number | null; question_score: number | null; explanation: string | null; duplicate: boolean }[] }
      submit_timed_answer: { Args: { p_challenge_date: string; p_question_position: number; p_guess: number; p_attempt_token: string }; Returns: { question_position: number; question_id: string; question_text: string; item_name: string; category: string; unit: string; location: string; outcome: 'active' | 'answered' | 'timed_out'; started_at: string; deadline_at: string; server_now: string; guess: number | null; actual_price: number | null; question_score: number | null; explanation: string | null; duplicate: boolean }[] }
      expire_timed_question: { Args: { p_challenge_date: string; p_question_position: number; p_attempt_token: string }; Returns: { question_position: number; question_id: string; question_text: string; item_name: string; category: string; unit: string; location: string; outcome: 'active' | 'answered' | 'timed_out'; started_at: string; deadline_at: string; server_now: string; guess: number | null; actual_price: number | null; question_score: number | null; explanation: string | null; duplicate: boolean }[] }
      submit_timed_daily_result: { Args: { p_challenge_date: string; p_attempt_token: string }; Returns: { result_id: string; total_score: number; question_scores: number[]; guesses: (number | null)[]; exact_guesses: number; average_error_percent: number | null; current_streak: number; best_streak: number; duplicate: boolean }[] }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
