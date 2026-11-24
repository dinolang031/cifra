import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let vite
let game

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  game = await vite.ssrLoadModule('/src/lib/game.ts')
})

after(async () => {
  await vite?.close()
})

function freshGuestProgress(date = '2026-11-25', start = 1_000_000) {
  const daily = game.newDaily(date)
  return {
    daily,
    progress: game.createGuestTimedDaily(daily, true, start),
    start,
  }
}

test('guest question timer starts explicitly and retains its persisted deadline', () => {
  const { daily, progress, start } = freshGuestProgress()
  assert.equal(progress.questions.length, 1)
  assert.equal(Date.parse(progress.questions[0].deadlineAt) - Date.parse(progress.questions[0].startedAt), 20_000)
  assert.equal(progress.questions[0].outcome, 'active')
  assert.equal(progress.questions[0].actualPrice, null)
  assert.equal(progress.questions[0].guess, null)

  globalThis.localStorage = {
    value: null,
    getItem() { return this.value },
    setItem(_key, value) { this.value = value },
    removeItem() { this.value = null },
  }
  const state = { ...game.loadState('timed-test', daily.date), timedDaily: progress }
  assert.equal(game.saveState(state, 'timed-test'), true)
  const restored = game.loadState('timed-test', daily.date)
  assert.equal(restored.timedDaily.questions[0].deadlineAt, progress.questions[0].deadlineAt)
  assert.deepEqual(restored.timedDaily.guestQuestionIds, daily.questionIds)
  assert.equal(game.remainingTimerMs(Date.parse(progress.questions[0].deadlineAt), start), 20_000)
})

test('an answer is accepted only before expiry and then reveals the score', () => {
  const { progress, start } = freshGuestProgress()
  const questionId = progress.questions[0].questionId
  const actual = game.getQuestions([questionId])[0].actualPrice

  assert.throws(() => game.resolveGuestTimedAnswer(progress, 1, actual, start + 20_000))
  const answered = game.resolveGuestTimedAnswer(progress, 1, actual, start + 19_999)
  assert.equal(answered.questions[0].outcome, 'answered')
  assert.equal(answered.questions[0].guess, actual)
  assert.equal(answered.questions[0].actualPrice, actual)
  assert.equal(answered.questions[0].score, 1000)
})

test('timeout records no guess, awards zero, and cannot later be changed', () => {
  const { progress } = freshGuestProgress()
  const timedOut = game.resolveGuestTimedTimeout(progress, 1, Date.parse(progress.questions[0].deadlineAt))
  assert.equal(timedOut.questions[0].outcome, 'timed_out')
  assert.equal(timedOut.questions[0].guess, null)
  assert.equal(timedOut.questions[0].score, 0)
  assert.ok(timedOut.questions[0].actualPrice > 0)
  assert.throws(() => game.resolveGuestTimedAnswer(timedOut, 1, 1))
  assert.throws(() => game.resolveGuestTimedTimeout(timedOut, 1))
})

test('all-timeout challenge completes with zero score and no fabricated accuracy', () => {
  const { daily, progress: initial } = freshGuestProgress('2026-11-25', 2_000_000)
  let progress = initial
  for (let position = 1; position <= 5; position++) {
    const active = progress.questions.at(-1)
    progress = game.resolveGuestTimedTimeout(progress, position, Date.parse(active.deadlineAt))
    if (position < 5) progress = game.startGuestTimedQuestion(progress, Date.parse(active.deadlineAt) + 1)
  }

  const state = game.loadState('empty-timed-state', daily.date)
  const completed = game.completeGuestTimedDaily(state, progress, 3_000_000)
  assert.equal(completed.daily.completed, true)
  assert.deepEqual(completed.daily.guesses, [null, null, null, null, null])
  assert.deepEqual(completed.daily.scores, [0, 0, 0, 0, 0])
  assert.equal(completed.totalGames, 1)
  assert.equal(completed.history[0].accuracy, null)
  assert.equal(completed.currentStreak, 1)
})
