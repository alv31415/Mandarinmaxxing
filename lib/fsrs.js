// FSRS-5 spaced-repetition scheduler (the algorithm used by modern Anki), default parameters.
// Memory model per card: stability S (days until recall probability drops to 90%) and
// difficulty D (1..10). Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
export const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];

const DECAY = -0.5;
const FACTOR = 19 / 81;
const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
export const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 };
export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 };

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

export const retrievability = (elapsedDays, S) => S > 0 ? Math.pow(1 + FACTOR * elapsedDays / S, DECAY) : 0;
export const intervalFor = (S, retention = 0.9) =>
  clamp(Math.round((S / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1)), 1, 36500);

const initStability = (g) => Math.max(W[g - 1], 0.1);
const initDifficulty = (g) => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);

function nextDifficulty(D, g) {
  const delta = -W[6] * (g - 3);
  const damped = D + delta * (10 - D) / 9;
  return clamp(W[7] * initDifficulty(4) + (1 - W[7]) * damped, 1, 10);
}
function recallStability(D, S, R, g) {
  const hard = g === 2 ? W[15] : 1, easy = g === 4 ? W[16] : 1;
  return S * (1 + Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp(W[10] * (1 - R)) - 1) * hard * easy);
}
function forgetStability(D, S, R) {
  return Math.min(W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R)), S);
}
const shortTermStability = (S, g) => S * Math.exp(W[17] * (g - 3 + W[18]));

// Short "learning" steps before a card graduates to day-scale intervals.
const STEPS = {
  [State.New]:        { 1: 1 * MIN, 2: 5 * MIN, 3: 10 * MIN },
  [State.Learning]:   { 1: 1 * MIN, 2: 5 * MIN },
  [State.Relearning]: { 1: 5 * MIN, 2: 10 * MIN },
};

/**
 * Apply a rating to a card. Pure: returns the new scheduling fields.
 * card: { state, due, stability, difficulty, reps, lapses, last_review }
 */
export function schedule(card, rating, now = Date.now(), retention = 0.9) {
  const g = rating;
  const c = { ...card };
  const elapsedDays = c.last_review != null ? Math.max(0, (now - c.last_review) / DAY) : 0;

  if (c.state === State.New || !(c.stability > 0)) {
    c.stability = initStability(g);
    c.difficulty = initDifficulty(g);
  } else if (c.state === State.Review) {
    const R = retrievability(elapsedDays, c.stability);
    c.stability = g === 1 ? forgetStability(c.difficulty, c.stability, R) : recallStability(c.difficulty, c.stability, R, g);
    c.difficulty = nextDifficulty(c.difficulty, g);
  } else { // learning / relearning: same-session update
    c.stability = elapsedDays < 1
      ? shortTermStability(c.stability, g)
      : (g === 1 ? forgetStability(c.difficulty, c.stability, retrievability(elapsedDays, c.stability))
                 : recallStability(c.difficulty, c.stability, retrievability(elapsedDays, c.stability), g));
    c.difficulty = nextDifficulty(c.difficulty, g);
  }
  c.stability = clamp(c.stability, 0.01, 36500);

  const prevState = card.state;
  const step = STEPS[prevState]?.[g];
  if (prevState === State.Review && g === 1) {
    c.state = State.Relearning; c.lapses = (c.lapses || 0) + 1; c.due = now + STEPS[State.Relearning][1];
  } else if (prevState !== State.Review && step !== undefined) {
    c.state = prevState === State.Relearning ? State.Relearning : State.Learning;
    c.due = now + step;
  } else {
    let days = intervalFor(c.stability, retention);
    if (prevState === State.Review) { // keep hard < good < easy distinguishable
      const R = retrievability(elapsedDays, card.stability);
      const iv = (r) => intervalFor(clamp(recallStability(card.difficulty, card.stability, R, r), 0.01, 36500), retention);
      const hard = iv(2), good = Math.max(iv(3), hard + 1), easy = Math.max(iv(4), good + 1);
      days = g === 2 ? hard : g === 3 ? good : easy;
    }
    c.state = State.Review; c.due = now + days * DAY;
  }
  c.reps = (c.reps || 0) + 1;
  c.last_review = now;
  return c;
}

/** What each button would do, for showing intervals on the grade buttons. */
export function preview(card, now = Date.now(), retention = 0.9) {
  const out = {};
  for (const g of [1, 2, 3, 4]) out[g] = schedule(card, g, now, retention).due - now;
  return out;
}

export function humanInterval(ms) {
  const m = ms / MIN;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const d = ms / DAY;
  if (d < 1) return `${Math.round(m / 60)}h`;
  if (d < 31) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30).toFixed(1).replace(/\.0$/, '')}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
}
