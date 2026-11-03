/* ==========================================================================
   KEYVERSE – KeyMagnet engine (Vanilla JavaScript, ES6+)

   The player sees a big target letter and must press the matching physical
   key as quickly and accurately as possible.

   Architecture (read top to bottom):
     1. CONFIG ............ key sets, difficulty levels, scoring rules, keyboard
     2. STATE ............. one object describes the current session
     3. DOM ............... elements cached once in cacheDom()
     4. HELPERS ........... maths, formatting and time helpers
     5. TARGET GENERATION . shuffled "decks" built from the key-set arrays
     6. TARGET & INPUT .... keyboard handling, correct / wrong / timeout rules
     7. TIMING ............ one requestAnimationFrame loop, deadline checks,
                            pause-safe clock (performance.now)
     8. VIEWS & STATE ..... launch screen, start, pause, end, reset
     9. LAUNCH SCREEN ..... cards for practice sets and difficulty, preview
    10. PLAY VISUALS ...... keyboard, top bar, combo, progress, effects
    11. SOUND ............. Web Audio tones (toggleable)
    12. EVENTS & INIT ..... every listener attached exactly once
   ========================================================================== */

const KeyMagnet = (() => {
    'use strict';

    /* ------------------------------------------------------------------------
       1. CONFIG – every rule and every label of the game lives here
       ------------------------------------------------------------------------ */
    const CONFIG = Object.freeze({
        // Practice sets: the arrays the target letters are generated from.
        // accent controls the card's identity colour (see keymagnet.css).
        keySets: Object.freeze({
            home: Object.freeze({
                label: 'Home Row',
                tagline: 'Resting fingers. The foundation of touch typing.',
                icon: 'bi-hand-index-thumb',
                accent: 'cyan',
                keys: Object.freeze(['A', 'S', 'D', 'F', 'J', 'K', 'L'])
            }),
            top: Object.freeze({
                label: 'Top Row',
                tagline: 'Reach upward without moving your hands.',
                icon: 'bi-arrow-up-square',
                accent: 'blue',
                keys: Object.freeze(['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'])
            }),
            bottom: Object.freeze({
                label: 'Bottom Row',
                tagline: 'The hardest reach. Build control in the lower rows.',
                icon: 'bi-arrow-down-square',
                accent: 'violet',
                keys: Object.freeze(['Z', 'X', 'C', 'V', 'B', 'N', 'M'])
            }),
            all: Object.freeze({
                label: 'All Letters',
                tagline: 'The full alphabet. Every letter is fair game.',
                icon: 'bi-grid-3x3-gap',
                accent: 'ice',
                keys: Object.freeze('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
            })
        }),

        // Difficulty levels – each value changes how the game plays
        //   level      : 1–3, shown as bars on the card
        //   seconds    : total session length
        //   targets    : number of targets before the session ends early
        //   window     : seconds the player has to answer each target (timeout = miss)
        //   delay      : pause between answering one target and showing the next
        //   basePoints : points for one correct answer (before the combo multiplier)
        //   penalty    : points lost for a wrong key or a timeout (never below 0)
        difficulties: Object.freeze({
            easy: Object.freeze({
                label: 'Easy', level: 1, accent: 'cyan',
                tagline: 'Room to think. Forgiving scoring.',
                seconds: 90, targets: 20, window: 3.0, delay: 0.7,
                basePoints: 8, penalty: 2
            }),
            medium: Object.freeze({
                label: 'Medium', level: 2, accent: 'blue',
                tagline: 'A balanced test of speed and accuracy.',
                seconds: 75, targets: 30, window: 2.2, delay: 0.4,
                basePoints: 10, penalty: 4
            }),
            hard: Object.freeze({
                label: 'Hard', level: 3, accent: 'violet',
                tagline: 'Fast targets, tight windows, high rewards.',
                seconds: 60, targets: 40, window: 1.4, delay: 0.15,
                basePoints: 15, penalty: 6
            })
        }),

        // Combo multiplier: x1 for 0–4 streak, x2 for 5–9, x3 for 10–14, x4 from 15
        comboPerMultiplier: 5,
        maxMultiplier: 4,

        // Real QWERTY layout, three rows, used for the play keyboard and the preview
        keyboardRows: Object.freeze([
            Object.freeze(['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P']),
            Object.freeze(['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L']),
            Object.freeze(['Z', 'X', 'C', 'V', 'B', 'N', 'M'])
        ])
    });

    /* ------------------------------------------------------------------------
       2. STATE – one object describes the session
       status values:
         'ready'   → launch screen shown, nothing running
         'playing' → the frame loop is running and keys are accepted
         'paused'  → loop stopped, keys ignored, clock frozen
         'results' → session finished, keys ignored, results shown
       Times are performance.now() values in milliseconds.
       ------------------------------------------------------------------------ */
    const state = {
        status: 'ready',
        setKey: 'home',
        difficulty: 'medium',

        // Statistics
        score: 0,
        correct: 0,
        incorrect: 0,        // wrong keys + timeouts
        timeouts: 0,         // subset of incorrect: no key pressed in time
        answered: 0,         // correct + incorrect (one per target)
        combo: 0,
        bestCombo: 0,
        reactionTimes: [],   // ms for every key press (correct and wrong)
        lastReaction: null,

        // Target generation
        deck: [],            // letters still to show in the current shuffled deck
        targetLetter: null,

        // Clocks (performance.now values)
        targetShownAt: 0,    // when the current target appeared (reaction start)
        windowEndsAt: 0,     // deadline for answering the current target
        windowLength: 0,     // ms, used to draw the countdown bar
        nextTargetAt: null,  // when the next target appears (null while answering)
        gameEndsAt: 0,       // session deadline
        pausedAt: 0,
        endedAt: 0,
        endReason: '',

        // Loop and options
        rafId: null,
        soundOn: true
    };

    // Last values shown in the top bar and combo badge. Used to trigger
    // "bump" animations only when a number actually changes.
    const shown = { score: 0, combo: 0 };

    /* ------------------------------------------------------------------------
       3. DOM – every element we touch, looked up once
       ------------------------------------------------------------------------ */
    const dom = {};

    function cacheDom() {
        const byId = [
            // Launch screen
            'modeGrid', 'diffGrid', 'previewCard', 'previewTarget',
            'previewCount', 'previewKeyboard', 'startSummary', 'btnStart',
            // Play view: top bar
            'playView', 'hudScore', 'hudAccuracy', 'hudTime', 'chipSet', 'chipDiff',
            'btnPause', 'btnRestart', 'btnReset', 'btnSound',
            // Progress and combo
            'progressText', 'progressBar', 'comboBadge', 'hudCombo', 'hudMultiplier',
            // Arena
            'stage', 'targetWrap', 'targetKey', 'windowBar', 'feedbackLayer', 'keyboard',
            // Overlay buttons
            'btnResume', 'btnQuit', 'btnPlayAgain', 'btnChangeSettings',
            // Results
            'resMessage', 'resReason', 'resScore', 'resSetLine', 'resCorrect',
            'resIncorrect', 'resTimeouts', 'resAccuracy', 'resAvg', 'resCombo'
        ];
        byId.forEach((id) => { dom[id] = document.getElementById(id); });

        // The launch section in keymagnet.html has id="launch" (not "launchView")
        dom.launchView = document.getElementById('launch');

        dom.overlays = {
            pause: document.getElementById('overlayPause'),
            results: document.getElementById('overlayResults')
        };

        dom.pauseIcon = dom.btnPause.querySelector('i');
        dom.soundIcon = dom.btnSound.querySelector('i');
        dom.keyEls = new Map();    // letter → keycap element, filled by buildKeyboard()
    }

    /* ------------------------------------------------------------------------
       4. HELPERS
       ------------------------------------------------------------------------ */
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const now = () => performance.now();

    const currentSet = () => CONFIG.keySets[state.setKey];
    const currentDifficulty = () => CONFIG.difficulties[state.difficulty];
    const isLocked = () => state.status === 'playing' || state.status === 'paused';

    // Combo multiplier: a streak of 5 gives x2, 10 gives x3, 15 or more gives x4
    const getMultiplier = (combo) =>
        Math.min(CONFIG.maxMultiplier, 1 + Math.floor(combo / CONFIG.comboPerMultiplier));

    // Time used for the countdown. Frozen while paused, and fixed at the end.
    function clockNow() {
        if (state.status === 'paused') return state.pausedAt;
        if (state.status === 'results') return state.endedAt;
        return now();
    }

    // Seconds left in the session (full length before the first game starts)
    function remainingSeconds() {
        if (state.status === 'ready') return currentDifficulty().seconds;
        return Math.max(0, (state.gameEndsAt - clockNow()) / 1000);
    }

    // 75.4 s → "1:16" (rounded up so the timer does not show 0:00 too early)
    function formatTime(seconds) {
        const total = Math.ceil(seconds);
        const minutes = Math.floor(total / 60);
        return `${minutes}:${String(total % 60).padStart(2, '0')}`;
    }

    // 412.7 ms → "413 ms"; no data yet → "—"
    const formatMs = (ms) => (ms === null || ms === undefined ? '—' : `${Math.round(ms)} ms`);

    // Accuracy = correct ÷ (correct + incorrect). Timeouts count as incorrect.
    function accuracyPercent() {
        const attempts = state.correct + state.incorrect;
        return attempts ? Math.round((state.correct / attempts) * 100) : 0;
    }

    // Average of every recorded key press reaction time (correct and wrong)
    function averageReaction() {
        if (state.reactionTimes.length === 0) return null;
        const total = state.reactionTimes.reduce((sum, ms) => sum + ms, 0);
        return total / state.reactionTimes.length;
    }

    // Restarts a CSS animation by removing the class, forcing a reflow, and adding it back
    function retriggerClass(el, className) {
        el.classList.remove(className);
        void el.offsetWidth;
        el.classList.add(className);
    }

    /* ------------------------------------------------------------------------
       5. TARGET GENERATION – shuffled decks built from the set's array
          A deck contains every letter of the set exactly once, in random order.
          When the deck is empty a new one is shuffled, so every letter appears
          equally often and no letter repeats too early.
       ------------------------------------------------------------------------ */

    // Fisher–Yates shuffle: returns a new shuffled copy of the array
    function shuffle(list) {
        const copy = [...list];
        for (let i = copy.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    function refillDeck() {
        const deck = shuffle(currentSet().keys);

        // Avoid the same letter twice in a row across the boundary between two decks
        if (deck.length > 1 && deck[0] === state.targetLetter) {
            [deck[0], deck[1]] = [deck[1], deck[0]];
        }
        state.deck = deck;
    }

    // Takes the next letter from the deck, refilling it when empty
    function takeNextTargetLetter() {
        if (state.deck.length === 0) refillDeck();
        return state.deck.shift();
    }

    /* ------------------------------------------------------------------------
       6. TARGET DISPLAY & INPUT
       ------------------------------------------------------------------------ */

    // Shows a new target: big letter with entrance animation, keyboard highlight,
    // and a fresh response window
    function presentTarget(t) {
        state.targetLetter = takeNextTargetLetter();
        state.targetShownAt = t;
        state.windowLength = currentDifficulty().window * 1000;
        state.windowEndsAt = t + state.windowLength;
        state.nextTargetAt = null;

        dom.targetKey.textContent = state.targetLetter;
        retriggerClass(dom.targetKey, 'is-enter');
        dom.targetWrap.classList.remove('is-waiting');
        highlightTarget(state.targetLetter);
    }

    // Highlights exactly one keycap on the virtual keyboard
    function highlightTarget(letter) {
        dom.keyEls.forEach((el) => el.classList.remove('is-target'));
        const el = letter ? dom.keyEls.get(letter) : null;
        if (el) el.classList.add('is-target');
    }

    // Keyboard listener: called for every letter key the player presses
    function handleKeyPress(letter) {
        // Ignore input unless a target is being answered (not paused, not between targets)
        if (state.status !== 'playing' || state.nextTargetAt !== null) return;

        const reaction = now() - state.targetShownAt;

        if (letter === state.targetLetter) {
            registerCorrect(letter, reaction);
        } else {
            registerWrongKey(letter, reaction);
        }
        updateHud();
    }

    function registerCorrect(letter, reaction) {
        state.correct += 1;
        state.combo += 1;
        state.bestCombo = Math.max(state.bestCombo, state.combo);

        const points = currentDifficulty().basePoints * getMultiplier(state.combo);
        state.score += points;
        recordReaction(reaction);

        flashKey(letter, 'is-correct');
        flashStage('is-correct-flash');
        showHitText(`+${points}`, 'good');
        spawnBurst('good');
        playTone(880, 0.12, 'sine', 0.08);

        finishAttempt();
    }

    function registerWrongKey(letter, reaction) {
        const penalty = currentDifficulty().penalty;
        state.incorrect += 1;
        state.combo = 0;
        state.score = Math.max(0, state.score - penalty);
        recordReaction(reaction);

        flashKey(letter, 'is-wrong');
        flashStage('is-wrong-flash');
        showHitText(`${letter} is not the target · −${penalty}`, 'bad');
        spawnBurst('bad');
        playTone(180, 0.18, 'sawtooth', 0.05);

        finishAttempt();
    }

    // The player did not press anything before the window closed
    function registerTimeout() {
        const penalty = currentDifficulty().penalty;
        state.incorrect += 1;
        state.timeouts += 1;
        state.combo = 0;
        state.score = Math.max(0, state.score - penalty);
        state.lastReaction = null;

        flashKey(state.targetLetter, 'is-wrong');
        flashStage('is-wrong-flash');
        showHitText(`Too slow · −${penalty}`, 'bad');
        spawnBurst('bad');
        playTone(140, 0.3, 'triangle', 0.08, 100);

        finishAttempt();
    }

    function recordReaction(ms) {
        state.reactionTimes.push(ms);
        state.lastReaction = ms;
    }

    // Ends the current target. Either the session ends, or a short pause
    // starts and the next target will appear after it.
    function finishAttempt() {
        state.answered += 1;

        if (state.answered >= currentDifficulty().targets) {
            endGame('All targets completed');
            return;
        }

        state.nextTargetAt = now() + currentDifficulty().delay * 1000;
        dom.targetWrap.classList.add('is-waiting');
    }

    /* ------------------------------------------------------------------------
       7. TIMING – one requestAnimationFrame loop, deadline based
       Every timer is a deadline (a performance.now() value). Each frame we
       compare the current time with the deadlines. There are no setInterval
       or setTimeout calls, so there are no timers to clean up.
       ------------------------------------------------------------------------ */
    function startLoop() {
        if (state.rafId !== null) return;     // never run two loops
        state.rafId = requestAnimationFrame(frame);
    }

    function stopLoop() {
        if (state.rafId !== null) cancelAnimationFrame(state.rafId);
        state.rafId = null;
    }

    function frame() {
        state.rafId = null;
        if (state.status !== 'playing') return;

        const t = now();

        // 1) Session time over?
        if (t >= state.gameEndsAt) {
            endGame('Time is up');
            return;
        }

        // 2) Between targets: show the next one when its time comes.
        //    Otherwise: check whether the response window has expired.
        if (state.nextTargetAt !== null) {
            if (t >= state.nextTargetAt) presentTarget(t);
        } else if (t >= state.windowEndsAt) {
            registerTimeout();
            if (state.status !== 'playing') return;   // the timeout may have ended the session
        }

        if (state.status === 'playing') {
            updateTimers(t);
            state.rafId = requestAnimationFrame(frame);
        }
    }

    // Updates the countdown bar under the target and the HUD each frame
    function updateTimers(t) {
        if (state.nextTargetAt !== null) {
            dom.windowBar.style.transform = 'scaleX(1)';
            dom.windowBar.classList.remove('is-low');
        } else {
            const fraction = clamp((state.windowEndsAt - t) / state.windowLength, 0, 1);
            dom.windowBar.style.transform = `scaleX(${fraction.toFixed(3)})`;
            dom.windowBar.classList.toggle('is-low', fraction < 0.3);
        }
        updateHud();
    }

    // Shifts every deadline forward by the time spent paused, so pausing
    // does not steal time or inflate reaction times
    function shiftClock(ms) {
        state.gameEndsAt += ms;
        state.targetShownAt += ms;
        state.windowEndsAt += ms;
        if (state.nextTargetAt !== null) state.nextTargetAt += ms;
    }

    /* ------------------------------------------------------------------------
       8. VIEWS & STATE
       ------------------------------------------------------------------------ */

    // Clears every statistic and the deck, so a new session starts from zero
    function resetStats() {
        state.score = 0;
        state.correct = 0;
        state.incorrect = 0;
        state.timeouts = 0;
        state.answered = 0;
        state.combo = 0;
        state.bestCombo = 0;
        state.reactionTimes = [];
        state.lastReaction = null;

        state.deck = [];
        state.targetLetter = null;

        state.targetShownAt = 0;
        state.windowEndsAt = 0;
        state.windowLength = 0;
        state.nextTargetAt = null;
        state.gameEndsAt = 0;
        state.pausedAt = 0;
        state.endedAt = 0;
        state.endReason = '';

        shown.score = 0;
        shown.combo = 0;
    }

    // Launch screen: nothing running, all stats cleared, selections kept
    function showLaunch() {
        stopLoop();
        resetStats();
        clearFx();

        state.status = 'ready';
        dom.targetKey.textContent = '–';
        dom.targetWrap.classList.remove('is-waiting');
        highlightTarget(null);
        dom.windowBar.style.transform = 'scaleX(1)';

        setOverlay(null);
        dom.launchView.hidden = false;
        dom.playView.hidden = true;

        updateLaunch();
        updateControls();
        updateHud();
    }

    // Play view: shown when a session starts
    function showPlay() {
        dom.launchView.hidden = true;
        dom.playView.hidden = false;
        if (window.scrollY > 120) {
            dom.playView.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function startGame() {
        stopLoop();                       // never leave an old loop running
        ensureAudio();
        resetStats();
        clearFx();
        showPlay();

        const t = now();
        state.status = 'playing';
        state.gameEndsAt = t + currentDifficulty().seconds * 1000;

        setOverlay(null);
        presentTarget(t);
        startLoop();

        updateControls();
        updateHud();
    }

    function pauseGame() {
        if (state.status !== 'playing') return;

        state.status = 'paused';
        state.pausedAt = now();
        stopLoop();
        setOverlay('pause');
        updateControls();
        updateHud();
    }

    function resumeGame() {
        if (state.status !== 'paused') return;

        const pausedFor = now() - state.pausedAt;
        shiftClock(pausedFor);

        state.status = 'playing';
        setOverlay(null);
        startLoop();
        updateControls();
    }

    function togglePause() {
        if (state.status === 'playing') pauseGame();
        else if (state.status === 'paused') resumeGame();
    }

    // Ends the session and shows the results. After this, input is ignored.
    function endGame(reason) {
        if (!isLocked()) return;

        state.status = 'results';
        state.endedAt = now();
        state.endReason = reason;
        state.nextTargetAt = null;
        stopLoop();

        dom.targetWrap.classList.remove('is-waiting');
        highlightTarget(null);
        fillResults();
        setOverlay('results');
        playTone(440, 0.9, 'triangle', 0.09, 110);

        updateControls();
        updateHud();
    }

    // Practice set and difficulty can be changed only on the launch screen
    function setPracticeSet(key) {
        if (isLocked() || !CONFIG.keySets[key]) return;
        state.setKey = key;
        updateLaunch();
        updateKeyboardSetMarkers();
        updateHud();
    }

    function setDifficulty(key) {
        if (isLocked() || !CONFIG.difficulties[key]) return;
        state.difficulty = key;
        updateLaunch();
        updateHud();
    }

    // Shows exactly one overlay (or none) and focuses its main button
    const OVERLAY_FOCUS = { pause: 'btnResume', results: 'btnPlayAgain' };

    function setOverlay(name) {
        Object.entries(dom.overlays).forEach(([key, el]) => {
            el.classList.toggle('is-visible', key === name);
        });

        if (name && OVERLAY_FOCUS[name]) {
            dom[OVERLAY_FOCUS[name]].focus({ preventScroll: true });
        }
    }

    /* ------------------------------------------------------------------------
       9. LAUNCH SCREEN – practice set cards, difficulty cards and preview
          The cards are built once from CONFIG (so the text always matches the
          real rules), then updated whenever the selection changes.
       ------------------------------------------------------------------------ */

    // Builds the practice set cards and the difficulty cards, and the preview keyboard
    function buildLaunch() {
        // Key set tiles: name, tagline and a full keyboard illustration in which
        // the set's keys are lit in the tile's accent colour
        dom.modeGrid.innerHTML = Object.entries(CONFIG.keySets).map(([key, set]) => `
      <button type="button" class="km-set" role="radio" aria-checked="false"
              data-set="${key}" data-accent="${set.accent}">
        <span class="km-set-top">
          <strong>${set.label}</strong>
          <span class="km-set-check" aria-hidden="true"><i class="bi bi-check-lg"></i></span>
        </span>
        <span class="km-set-tag">${set.tagline}</span>
        <span class="km-set-kb" aria-hidden="true">
          ${CONFIG.keyboardRows.map((row) => `
            <span class="km-mini-row">
              ${row.map((letter) => `<span class="km-mini-key${set.keys.includes(letter) ? ' is-set' : ''}">${letter}</span>`).join('')}
            </span>`).join('')}
        </span>
        <span class="km-set-count">${set.keys.length} keys</span>
      </button>`).join('');

        // Difficulty rows: name and tagline on the left, three meters on the right.
        // Each meter fill is a visual share of the largest value in the game.
        dom.diffGrid.innerHTML = Object.entries(CONFIG.difficulties).map(([key, d]) => `
      <button type="button" class="km-diff" role="radio" aria-checked="false"
              data-diff="${key}" data-accent="${d.accent}">
        <span class="km-diff-main">
          <span class="km-diff-level">Level ${d.level}</span>
          <strong>${d.label}</strong>
          <span class="km-diff-tag">${d.tagline}</span>
        </span>
        <span class="km-meters" aria-hidden="true">
          <span class="km-meter"><small>Clock</small><b>${d.seconds}s</b><i style="--fill: ${Math.round((d.seconds / 90) * 100)}%"></i></span>
          <span class="km-meter"><small>Per target</small><b>${d.window.toFixed(1)}s</b><i style="--fill: ${Math.round((d.window / 3) * 100)}%"></i></span>
          <span class="km-meter"><small>Points</small><b>+${d.basePoints} / −${d.penalty}</b><i style="--fill: ${Math.round((d.basePoints / 15) * 100)}%"></i></span>
        </span>
        <span class="km-diff-check" aria-hidden="true"><i class="bi bi-check-lg"></i></span>
      </button>`).join('');

        // Preview keyboard: the same QWERTY rows as the play keyboard
        dom.previewKeyboard.innerHTML = CONFIG.keyboardRows.map((row) => `
      <div class="km-mini-row">
        ${row.map((letter) => `<span class="km-mini-key" data-key="${letter}">${letter}</span>`).join('')}
      </div>`).join('');
    }

    // Refreshes selection states, the preview and the start summary
    function updateLaunch() {
        const set = currentSet();
        const diff = currentDifficulty();

        dom.modeGrid.querySelectorAll('[data-set]').forEach((card) => {
            const selected = card.dataset.set === state.setKey;
            card.setAttribute('aria-checked', String(selected));
        });

        dom.diffGrid.querySelectorAll('[data-diff]').forEach((card) => {
            const selected = card.dataset.diff === state.difficulty;
            card.setAttribute('aria-checked', String(selected));
        });

        // Preview: accent follows the selected set, sample letter swaps in with animation
        dom.previewCard.dataset.accent = set.accent;
        const sample = set.keys[0];
        if (dom.previewTarget.textContent !== sample) {
            dom.previewTarget.textContent = sample;
            retriggerClass(dom.previewTarget, 'is-swap');
        }
        dom.previewCount.textContent = `${set.keys.length} keys`;

        const setKeys = set.keys;
        dom.previewKeyboard.querySelectorAll('[data-key]').forEach((el) => {
            el.classList.toggle('is-set', setKeys.includes(el.dataset.key));
        });

        dom.startSummary.textContent =
            `${set.label} · ${diff.label} · ${diff.seconds} seconds · ${diff.targets} targets`;
    }

    /* ------------------------------------------------------------------------
       10. PLAY VISUALS – keyboard, top bar, combo, progress and effects
       ------------------------------------------------------------------------ */

    // Builds the play keyboard from CONFIG.keyboardRows (arrays → keycaps)
    function buildKeyboard() {
        dom.keyboard.innerHTML = '';
        dom.keyEls.clear();

        CONFIG.keyboardRows.forEach((row, rowIndex) => {
            const rowEl = document.createElement('div');
            rowEl.className = `km-kb-row km-kb-row--${rowIndex}`;

            row.forEach((letter) => {
                const key = document.createElement('span');
                key.className = 'km-kb-key';
                key.dataset.key = letter;
                key.textContent = letter;
                rowEl.appendChild(key);
                dom.keyEls.set(letter, key);
            });

            dom.keyboard.appendChild(rowEl);
        });
    }

    // Marks the keys that belong to the selected practice set (dims the rest)
    function updateKeyboardSetMarkers() {
        const setKeys = currentSet().keys;
        dom.keyEls.forEach((el, letter) => {
            el.classList.toggle('is-in-set', setKeys.includes(letter));
        });
    }

    // Briefly colours a key mint (correct) or coral (wrong).
    // The class is removed by the delegated animationend listener in bindEvents().
    function flashKey(letter, className) {
        const el = letter ? dom.keyEls.get(letter) : null;
        if (el) retriggerClass(el, className);
    }

    // Adds one feedback class to the arena. .is-wrong-flash in the CSS holds
    // both the glow and the shake, so we never stack two animation classes.
    function flashStage(className) {
        retriggerClass(dom.stage, className);
    }

    // Floating feedback text in the centre of the arena
    function showHitText(text, type) {
        const el = document.createElement('p');
        el.className = `km-hit is-${type}`;
        el.textContent = text;
        el.addEventListener('animationend', () => el.remove(), { once: true });
        dom.feedbackLayer.appendChild(el);
    }

    // Expanding ring from the centre of the arena (mint for correct, coral for wrong)
    function spawnBurst(type) {
        const el = document.createElement('span');
        el.className = type === 'good' ? 'km-burst' : 'km-burst is-bad';
        el.addEventListener('animationend', () => el.remove(), { once: true });
        dom.feedbackLayer.appendChild(el);
    }

    // Removes floating text and rings left from a previous round
    function clearFx() {
        dom.feedbackLayer.innerHTML = '';
    }

    // Refreshes every live value. Called on each frame and after each event.
    function updateHud() {
        const diff = currentDifficulty();
        const attempts = state.correct + state.incorrect;
        const secs = remainingSeconds();

        // Top bar: exactly three metrics (score, accuracy, remaining time)
        if (state.score !== shown.score) {
            if (state.score > shown.score) retriggerClass(dom.hudScore, 'is-bump');
            shown.score = state.score;
        }
        dom.hudScore.textContent = state.score.toLocaleString();
        dom.hudAccuracy.textContent = attempts ? `${accuracyPercent()}%` : '—';
        dom.hudTime.textContent = formatTime(secs);
        dom.hudTime.classList.toggle('is-warning', state.status === 'playing' && secs <= 10);

        // Chips show the chosen practice set and difficulty
        dom.chipSet.textContent = currentSet().label;
        dom.chipDiff.textContent = diff.label;

        // Combo badge: bump on every change, extra pulse every 5 in a row
        const multiplier = getMultiplier(state.combo);
        dom.hudCombo.textContent = state.combo;
        dom.hudMultiplier.textContent = `x${multiplier}`;
        dom.comboBadge.classList.toggle('is-hot', multiplier > 1);
        if (state.combo !== shown.combo) {
            retriggerClass(dom.comboBadge, 'is-bump');
            if (state.combo > 0 && state.combo % CONFIG.comboPerMultiplier === 0) {
                retriggerClass(dom.comboBadge, 'is-milestone');
            }
            shown.combo = state.combo;
        }

        // Progress: targets answered out of the session total
        const fraction = state.answered / diff.targets;
        dom.progressBar.style.transform = `scaleX(${fraction.toFixed(3)})`;
        dom.progressText.textContent = `${state.answered} / ${diff.targets}`;
    }

    // Enables or disables the top-bar buttons for the current state
    function updateControls() {
        const locked = isLocked();

        dom.btnPause.disabled = !locked;
        dom.btnRestart.disabled = !locked;

        const isPaused = state.status === 'paused';
        dom.pauseIcon.className = isPaused ? 'bi bi-play-fill' : 'bi bi-pause-fill';
        dom.btnPause.setAttribute('aria-label', isPaused ? 'Resume game' : 'Pause game');
    }

    // Performance message from accuracy and average reaction time
    function performanceMessage(accuracy, avgMs) {
        if (state.answered === 0) return 'Session ended before the first target';
        if (accuracy >= 90 && avgMs !== null && avgMs < 700) return 'Elite precision at speed';
        if (accuracy >= 90) return 'Exceptional accuracy';
        if (accuracy >= 75) return 'Strong, controlled run';
        if (accuracy >= 50) return 'A solid base. Keep training';
        return 'Every session builds accuracy';
    }

    // Fills the results overlay from the statistics
    function fillResults() {
        const accuracy = accuracyPercent();
        const avg = averageReaction();
        const diff = currentDifficulty();

        dom.resMessage.textContent = performanceMessage(accuracy, avg);
        dom.resReason.textContent = state.endReason;
        dom.resScore.textContent = state.score.toLocaleString();
        dom.resSetLine.textContent = `${currentSet().label} · ${diff.label}`;
        dom.resCorrect.textContent = state.correct;
        dom.resIncorrect.textContent = state.incorrect;
        dom.resTimeouts.textContent = `${state.timeouts} timed out`;
        dom.resAccuracy.textContent = `${accuracy}%`;
        dom.resAvg.textContent = formatMs(avg);
        dom.resCombo.textContent = state.bestCombo;
    }

    /* ------------------------------------------------------------------------
       11. SOUND – Web Audio tones, created only after a user gesture
       ------------------------------------------------------------------------ */
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    let audioCtx = null;

    function ensureAudio() {
        if (!AudioContextClass) return;
        if (!audioCtx) audioCtx = new AudioContextClass();
        if (audioCtx.state === 'suspended') audioCtx.resume();
    }

    function playTone(frequency, duration, type, volume, slideTo = null) {
        if (!state.soundOn || !audioCtx || audioCtx.state !== 'running') return;

        const at = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(frequency, at);
        if (slideTo !== null) osc.frequency.exponentialRampToValueAtTime(slideTo, at + duration);

        gain.gain.setValueAtTime(volume, at);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

        osc.connect(gain).connect(audioCtx.destination);
        osc.start(at);
        osc.stop(at + duration);
    }

    function toggleSound() {
        state.soundOn = !state.soundOn;
        if (state.soundOn) ensureAudio();

        dom.btnSound.setAttribute('aria-pressed', String(state.soundOn));
        dom.btnSound.setAttribute('aria-label', state.soundOn ? 'Sound on' : 'Sound off');
        dom.soundIcon.className = state.soundOn ? 'bi bi-volume-up' : 'bi bi-volume-mute';
    }

    /* ------------------------------------------------------------------------
       12. EVENTS & INIT – every listener is attached exactly once, in bindEvents()
       ------------------------------------------------------------------------ */
    function onKeyDown(event) {
        // Escape pauses or resumes a running session
        if (event.key === 'Escape') {
            if (isLocked()) {
                event.preventDefault();
                togglePause();
            }
            return;
        }

        // Ignore auto-repeat and shortcuts such as Ctrl+R
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

        // Only single letters A–Z count as answers
        if (!/^[a-z]$/i.test(event.key)) return;

        handleKeyPress(event.key.toUpperCase());
    }

    function onVisibilityChange() {
        // Pause automatically when the player switches tabs
        if (document.hidden && state.status === 'playing') pauseGame();
    }

    // Click on a practice set card (event delegation: one listener, many cards)
    function onModeClick(event) {
        const card = event.target.closest('[data-set]');
        if (card) setPracticeSet(card.dataset.set);
    }

    // Click on a difficulty card (event delegation)
    function onDiffClick(event) {
        const card = event.target.closest('[data-diff]');
        if (card) setDifficulty(card.dataset.diff);
    }

    function bindEvents() {
        // Launch screen
        dom.btnStart.addEventListener('click', startGame);
        dom.modeGrid.addEventListener('click', onModeClick);
        dom.diffGrid.addEventListener('click', onDiffClick);

        // Top bar
        dom.btnPause.addEventListener('click', togglePause);
        dom.btnRestart.addEventListener('click', startGame);
        dom.btnReset.addEventListener('click', showLaunch);
        dom.btnSound.addEventListener('click', toggleSound);

        // Pause overlay
        dom.btnResume.addEventListener('click', resumeGame);
        dom.btnQuit.addEventListener('click', showLaunch);

        // Results overlay
        dom.btnPlayAgain.addEventListener('click', startGame);
        dom.btnChangeSettings.addEventListener('click', showLaunch);

        // One delegated listener per container removes every temporary animation
        // class, so no per-element listeners pile up during a long session
        dom.stage.addEventListener('animationend', (event) => {
            if (event.target !== dom.stage) return;
            dom.stage.classList.remove('is-correct-flash', 'is-wrong-flash');
        });
        dom.keyboard.addEventListener('animationend', (event) => {
            event.target.classList.remove('is-correct', 'is-wrong');
        });
        dom.targetKey.addEventListener('animationend', () => {
            dom.targetKey.classList.remove('is-enter');
        });
        dom.previewTarget.addEventListener('animationend', () => {
            dom.previewTarget.classList.remove('is-swap');
        });
        dom.comboBadge.addEventListener('animationend', (event) => {
            if (event.target !== dom.comboBadge) return;
            dom.comboBadge.classList.remove('is-bump', 'is-milestone');
        });
        dom.hudScore.addEventListener('animationend', () => {
            dom.hudScore.classList.remove('is-bump');
        });

        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    function init() {
        cacheDom();
        buildLaunch();
        buildKeyboard();
        resetStats();
        bindEvents();

        updateKeyboardSetMarkers();
        showLaunch();
    }

    init();

    return Object.freeze({
        version: '2.0.0',
        config: CONFIG
    });
})();