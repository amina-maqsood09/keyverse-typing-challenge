/* ==========================================================================
   KEYVERSE – Bubble Rush game engine (Vanilla JavaScript, ES6+)

   The whole game lives inside one IIFE that returns a tiny public API.
   Nothing leaks into the global scope except the BubbleRush name.

   Architecture (read top to bottom):
     1. CONFIG ........... every tunable number, colour and label
     2. STATE ............ the single source of truth for the game
     3. DOM ............... references to elements, cached once
     4. HELPERS ........... small pure functions (maths, formatting)
     5. SPAWNING .......... creating bubbles: letter, depth, tint, lane
     6. MOVEMENT .......... rising, swaying and escape detection (misses)
     7. MATCHING .......... keyboard input → pop a bubble or penalise a key
     8. GAME LOOP ......... ONE requestAnimationFrame loop, started/stopped
     9. STATE CHANGES ..... launch, start, pause, resume, game over, results
    10. LAUNCH SCREEN ..... difficulty cards and start summary
    11. HUD & CONTROLS .... keeps the screen in sync with the state
    12. SOUND ............. tiny Web Audio tones (toggleable)
    13. EVENTS & INIT ..... every listener is attached exactly once
   ========================================================================== */

const BubbleRush = (() => {
    'use strict';

    /* ------------------------------------------------------------------------
       1. CONFIG – change game balance and labels here, not in the logic
       ------------------------------------------------------------------------ */
    const CONFIG = Object.freeze({
        maxMisses: 6,                 // bubbles that may escape before the round ends
        minOnScreen: 5,               // a new bubble appears at once if fewer are visible
        letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        seedBubbles: 5,               // bubbles on screen when a round starts
        correctPoints: 10,            // base points for a correct key
        comboBonusCap: 10,            // combo bonus stops growing after this many hits
        comboBonusEach: 2,            // extra points per combo step (up to the cap)
        wrongPenalty: 5,              // points removed for a wrong key (never below 0)
        levelSeconds: 15,             // every 15 s of play raises the level
        speedStep: 0.1,               // +10 % bubble speed per level…
        maxSpeedMultiplier: 1.8,      // …but never more than 1.8× the base speed

        // Colours for bubbles: light tint for the body, deep tint for the shade.
        // All four come from the KEYVERSE palette.
        tints: Object.freeze([
            Object.freeze({ light: '#67E8F9', deep: '#0E7490', ink: '#050816' }),   // cyan
            Object.freeze({ light: '#60A5FA', deep: '#1D4ED8', ink: '#FFFFFF' }),   // electric blue
            Object.freeze({ light: '#C4B5FD', deep: '#6D28D9', ink: '#050816' }),   // violet
            Object.freeze({ light: '#F1F5FF', deep: '#94A3C8', ink: '#050816' })    // ice white
        ]),

        // speed      = fraction of the arena height a bubble travels per second
        // spawnEvery = seconds between new bubbles (before level scaling)
        // maxActive  = most bubbles allowed on screen at once (before level scaling)
        difficulties: Object.freeze({
            easy: Object.freeze({
                label: 'Easy', level: 1, accent: 'cyan',
                tagline: 'Slow, generous and forgiving. Good for warming up.',
                rise: 'Slow rise', seconds: 90, speed: 0.12, spawnEvery: 1.4, maxActive: 6
            }),
            medium: Object.freeze({
                label: 'Medium', level: 2, accent: 'blue',
                tagline: 'A steady rhythm that keeps you focused.',
                rise: 'Steady rise', seconds: 75, speed: 0.18, spawnEvery: 1.0, maxActive: 7
            }),
            hard: Object.freeze({
                label: 'Hard', level: 3, accent: 'violet',
                tagline: 'Fast bubbles and relentless spawns.',
                rise: 'Fast rise', seconds: 60, speed: 0.26, spawnEvery: 0.7, maxActive: 9
            })
        })
    });

    /* ------------------------------------------------------------------------
       2. STATE – one object describes the whole game at any moment
       status values:
         'ready'   → launch screen shown, nothing moving
         'playing' → the game loop is running
         'paused'  → the loop is stopped, pause overlay shown
         'over'    → round ended, round-over overlay shown
         'results' → results overlay shown
       ------------------------------------------------------------------------ */
    const state = {
        status: 'ready',
        difficulty: 'medium',
        score: 0,
        correct: 0,
        wrong: 0,
        misses: 0,
        combo: 0,
        bestCombo: 0,
        elapsed: 0,          // seconds of active play (pauses do not count)
        timeLeft: 0,
        level: 1,
        spawnTimer: 0,
        bubbles: [],         // every live bubble: { id, letter, r, x, y, baseX, el, … }
        nextId: 1,
        rafId: null,         // id of the single animation frame request (null = loop stopped)
        lastFrame: 0,
        soundOn: true,
        overReason: ''
    };

    // Last values shown in the HUD, so bump animations run only on real changes
    const shown = { score: 0, combo: 0 };

    /* ------------------------------------------------------------------------
       3. DOM – every element we touch, looked up once in cacheDom()
       ------------------------------------------------------------------------ */
    const dom = {};

    function cacheDom() {
        const byId = [
            // Launch screen
            'diffGrid', 'startSummary', 'btnStart',
            // Play view and top bar
            'playView', 'chipDiff', 'chipLevel', 'hudScore', 'hudTime', 'hudLives', 'hudCombo',
            'btnPause', 'btnRestart', 'btnReset', 'btnSound',
            // Arena
            'arena', 'escapeLine', 'bubbleLayer', 'feedbackLayer',
            // Overlay content and buttons
            'btnResume', 'btnQuit', 'overReason', 'overScore', 'btnSeeResults',
            'resMessage', 'resSetLine', 'resReason', 'resScore', 'resCorrect', 'resWrong',
            'resMisses', 'resAccuracy', 'resCombo', 'btnPlayAgain', 'btnChangeSettings'
        ];
        byId.forEach((id) => { dom[id] = document.getElementById(id); });

        dom.launchView = document.getElementById('launch');
        dom.overlays = {
            pause: document.getElementById('overlayPause'),
            over: document.getElementById('overlayOver'),
            results: document.getElementById('overlayResults')
        };

        dom.pauseIcon = dom.btnPause.querySelector('i');
        dom.soundIcon = dom.btnSound.querySelector('i');
    }

    /* ------------------------------------------------------------------------
       4. HELPERS – small, reusable, easy to explain in a viva
       ------------------------------------------------------------------------ */
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const randomBetween = (min, max) => min + Math.random() * (max - min);
    const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

    // 75.4 seconds → "1:16" (rounded up so the timer never shows 0:00 early)
    const formatTime = (seconds) => {
        const total = Math.max(0, Math.ceil(seconds));
        const minutes = Math.floor(total / 60);
        const secs = String(total % 60).padStart(2, '0');
        return `${minutes}:${secs}`;
    };

    const currentDifficulty = () => CONFIG.difficulties[state.difficulty];
    const getArenaSize = () => ({ w: dom.arena.clientWidth, h: dom.arena.clientHeight });

    // Base bubble radius scales with the arena width, kept between 28 px and 50 px
    const getBaseRadius = (w) => Math.round(clamp(w * 0.055, 28, 50));

    // Level rises every levelSeconds of play: level 1, 2, 3 …
    const getLevelFor = (elapsed) => 1 + Math.floor(elapsed / CONFIG.levelSeconds);

    // Speed multiplier, spawn interval and active cap all depend on the level
    const getSpeedMultiplier = (level) =>
        Math.min(CONFIG.maxSpeedMultiplier, 1 + (level - 1) * CONFIG.speedStep);

    const getSpawnInterval = (level) =>
        currentDifficulty().spawnEvery * Math.max(0.55, 1 - (level - 1) * 0.07);

    const getMaxActive = (level) =>
        currentDifficulty().maxActive + Math.min(2, Math.floor((level - 1) / 2));

    // Restarts a CSS animation by removing the class, forcing a reflow, and adding it back
    function retriggerClass(el, className) {
        el.classList.remove(className);
        void el.offsetWidth;
        el.classList.add(className);
    }

    /* ------------------------------------------------------------------------
       5. SPAWNING – letter, depth, colour and a clear lane for each bubble
       ------------------------------------------------------------------------ */

    // Prefer letters that are NOT already on screen, so the player sees variety
    function pickLetter() {
        const onScreen = new Set(state.bubbles.map((b) => b.letter));
        const free = [...CONFIG.letters].filter((letter) => !onScreen.has(letter));
        return pickRandom(free.length ? free : [...CONFIG.letters]);
    }

    // Try a few random x positions and keep the one farthest from bubbles
    // that are still near the bottom, so new bubbles do not overlap.
    function pickSpawnX(w, r, h) {
        const min = r + 8;
        const max = w - r - 8;
        const lowerBubbles = state.bubbles.filter((b) => b.y > h * 0.7);

        let bestX = randomBetween(min, max);
        let bestGap = -1;

        for (let attempt = 0; attempt < 6; attempt += 1) {
            const candidate = randomBetween(min, max);
            const gap = lowerBubbles.length
                ? Math.min(...lowerBubbles.map((b) => Math.abs(b.baseX - candidate)))
                : Infinity;

            if (gap > bestGap) {
                bestGap = gap;
                bestX = candidate;
            }
        }
        return bestX;
    }

    // Creates the DOM element for a bubble and appends it to the bubble layer.
    // The colour is passed as CSS custom properties, so the stylesheet owns the look.
    function buildBubbleElement(letter, r, tint) {
        const el = document.createElement('div');
        el.className = 'br-bubble';
        el.textContent = letter;
        el.setAttribute('aria-hidden', 'true');
        el.style.width = `${r * 2}px`;
        el.style.height = `${r * 2}px`;
        el.style.fontSize = `${Math.round(r * 0.95)}px`;
        el.style.setProperty('--bubble', tint.light);
        el.style.setProperty('--bubble-deep', tint.deep);
        el.style.setProperty('--ink', tint.ink);
        dom.bubbleLayer.appendChild(el);
        return el;
    }

    // startY = null → spawn just below the arena (normal spawn)
    // startY = number → spawn at that height (used for the opening bubbles)
    function spawnBubble(startY = null) {
        const { w, h } = getArenaSize();
        if (!w || !h) return;

        // Depth: smaller bubbles are "further away" and rise a little slower
        const depth = randomBetween(0.85, 1.15);
        const r = Math.round(getBaseRadius(w) * depth);
        const letter = pickLetter();
        const x = pickSpawnX(w, r, h);
        const tint = pickRandom(CONFIG.tints);

        const bubble = {
            id: state.nextId,
            letter,
            r,
            baseX: x,                       // centre x without the sway
            x,                              // centre x actually drawn (baseX + sway)
            y: startY !== null ? startY : h + r,
            speedFactor: depth,             // nearer (bigger) bubbles rise a little faster
            wobbleAmp: randomBetween(6, 14),        // how far it sways sideways (px)
            wobbleSpeed: randomBetween(1, 2.2),
            phase: randomBetween(0, Math.PI * 2),
            el: buildBubbleElement(letter, r, tint)
        };

        state.nextId += 1;
        state.bubbles.push(bubble);
        placeBubble(bubble);
    }

    // Opening bubbles so the arena is never empty at the start
    function seedBubbles() {
        const { h } = getArenaSize();
        for (let i = 0; i < CONFIG.seedBubbles; i += 1) {
            spawnBubble(randomBetween(h * 0.3, h * 0.92));
        }
    }

    /* ------------------------------------------------------------------------
       6. MOVEMENT – rise, sway, and detect escapes
       ------------------------------------------------------------------------ */

    // Draws a bubble at its current position (translate3d is cheap to animate)
    function placeBubble(bubble) {
        const sway = Math.sin(state.elapsed * bubble.wobbleSpeed + bubble.phase) * bubble.wobbleAmp;
        bubble.x = bubble.baseX + sway;
        bubble.el.style.transform =
            `translate3d(${(bubble.x - bubble.r).toFixed(1)}px, ${(bubble.y - bubble.r).toFixed(1)}px, 0)`;
    }

    // Moves every bubble up by (speed × time). Bubbles whose centre reaches
    // the top edge (y <= 0) escape: they are removed and counted as misses.
    function moveBubbles(dt, h) {
        const pixelsPerSecond = h * currentDifficulty().speed * getSpeedMultiplier(state.level);
        const escaped = [];

        state.bubbles = state.bubbles.filter((bubble) => {
            bubble.y -= pixelsPerSecond * bubble.speedFactor * dt;
            if (bubble.y <= 0) {
                escaped.push(bubble);
                return false;          // remove from the array
            }
            return true;
        });

        escaped.forEach((bubble) => {
            bubble.el.remove();
            registerMiss(bubble);
        });
    }

    /* ------------------------------------------------------------------------
       7. MATCHING – keyboard input rules
       ------------------------------------------------------------------------ */

    // Called for every letter key the player presses during a round
    function handleLetter(letter) {
        if (state.status !== 'playing') return;

        const matches = state.bubbles.filter((bubble) => bubble.letter === letter);

        if (matches.length === 0) {
            registerWrongKey(letter);
            return;
        }

        // If several bubbles show the same letter, pop the one closest to escaping
        const target = matches.reduce((a, b) => (a.y <= b.y ? a : b));
        popBubble(target);
    }

    // Correct key: remove the bubble, award points, grow the combo
    function popBubble(bubble) {
        state.bubbles = state.bubbles.filter((b) => b !== bubble);

        // Play the pop animation, then remove the element from the DOM
        bubble.el.classList.add('is-popping');
        removeWhenDone(bubble.el, 500);

        state.correct += 1;
        state.combo += 1;
        state.bestCombo = Math.max(state.bestCombo, state.combo);

        const bonus = Math.min(state.combo, CONFIG.comboBonusCap) * CONFIG.comboBonusEach;
        const points = CONFIG.correctPoints + bonus;
        state.score += points;

        showFeedback(`+${points}`, 'good', bubble.x, bubble.y);
        playTone(880, 0.12, 'sine', 0.08);
        updateHud();
    }

    // Wrong key: penalty, combo reset, shake and coral feedback
    function registerWrongKey(letter) {
        state.wrong += 1;
        state.combo = 0;
        state.score = Math.max(0, state.score - CONFIG.wrongPenalty);

        const { w, h } = getArenaSize();
        showFeedback(`${letter} · −${CONFIG.wrongPenalty}`, 'bad', w / 2, h * 0.84);
        shakeArena();
        playTone(180, 0.18, 'sawtooth', 0.05);
        updateHud();
    }

    // A bubble reached the escape line: count a miss and break the combo
    function registerMiss(bubble) {
        if (state.status !== 'playing') return;

        state.misses += 1;
        state.combo = 0;

        showFeedback(`Missed ${bubble.letter}`, 'bad', bubble.x, 22);
        pulseEscapeLine();
        playTone(140, 0.3, 'triangle', 0.09, 90);
        updateHud();

        if (state.misses >= CONFIG.maxMisses) {
            endGame(`${CONFIG.maxMisses} bubbles escaped`);
        }
    }

    /* ------------------------------------------------------------------------
       8. GAME LOOP – exactly one requestAnimationFrame loop
       startLoop() does nothing if a loop already exists, so duplicate loops
       cannot happen even if the player clicks buttons rapidly.
       ------------------------------------------------------------------------ */
    function startLoop() {
        if (state.rafId !== null) return;
        state.lastFrame = performance.now();
        state.rafId = requestAnimationFrame(frame);
    }

    function stopLoop() {
        if (state.rafId !== null) cancelAnimationFrame(state.rafId);
        state.rafId = null;
    }

    function frame(now) {
        state.rafId = null;

        // Time since the last frame, capped at 50 ms so a slow tab cannot teleport bubbles
        const dt = Math.min(0.05, (now - state.lastFrame) / 1000);
        state.lastFrame = now;

        if (state.status !== 'playing') return;

        step(dt);

        // step() may have ended the game; only schedule the next frame if still playing
        if (state.status === 'playing') {
            state.rafId = requestAnimationFrame(frame);
        }
    }

    // One game tick: timer, level, spawning, movement, drawing, HUD
    function step(dt) {
        const { w, h } = getArenaSize();

        state.elapsed += dt;
        state.timeLeft = currentDifficulty().seconds - state.elapsed;

        if (state.timeLeft <= 0) {
            state.timeLeft = 0;
            endGame("Time's up");
            return;
        }

        // Level up: speed and spawn rate increase, and a banner appears
        const newLevel = getLevelFor(state.elapsed);
        if (newLevel !== state.level) {
            state.level = newLevel;
            showFeedback(`Level ${newLevel} · Faster`, 'banner', w / 2, h * 0.42);
            playTone(990, 0.2, 'square', 0.04);
        }

        // Spawn a new bubble when the spawn timer passes the interval, never above
        // the active cap. If fewer than minOnScreen are visible, spawn right away.
        state.spawnTimer += dt;
        const underMinimum = state.bubbles.length < CONFIG.minOnScreen;
        const timerReady = state.spawnTimer >= getSpawnInterval(state.level);

        if ((timerReady || underMinimum) && state.bubbles.length < getMaxActive(state.level)) {
            state.spawnTimer = 0;
            spawnBubble();
        } else if (timerReady) {
            state.spawnTimer = 0;
        }

        moveBubbles(dt, h);

        // A miss may have ended the round during moveBubbles()
        if (state.status !== 'playing') return;

        state.bubbles.forEach(placeBubble);
        updateHud();
    }

    /* ------------------------------------------------------------------------
       9. STATE CHANGES – every transition goes through one of these functions
       ------------------------------------------------------------------------ */

    // Removes every bubble and feedback element from the screen
    function clearBubbles() {
        state.bubbles = [];
        dom.bubbleLayer.innerHTML = '';
        dom.feedbackLayer.innerHTML = '';
    }

    // Resets all counters to their starting values
    function resetStats() {
        state.score = 0;
        state.correct = 0;
        state.wrong = 0;
        state.misses = 0;
        state.combo = 0;
        state.bestCombo = 0;
        state.elapsed = 0;
        state.timeLeft = currentDifficulty().seconds;
        state.level = 1;
        state.spawnTimer = 0;
        state.overReason = '';

        shown.score = 0;
        shown.combo = 0;
    }

    // Launch screen: nothing running, nothing on screen, stats cleared
    function showLaunch() {
        stopLoop();
        clearBubbles();
        resetStats();
        state.status = 'ready';

        setOverlay(null);
        dom.launchView.hidden = false;
        dom.playView.hidden = true;

        updateLaunch();
        updateControls();
        updateHud();
    }

    // Play view: shown when a round starts
    function showPlay() {
        dom.launchView.hidden = true;
        dom.playView.hidden = false;
        if (window.scrollY > 120) {
            dom.playView.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // Start a brand-new round (also used by Restart and Play Again)
    function startGame() {
        stopLoop();                 // never leave an old loop running
        ensureAudio();
        clearBubbles();
        resetStats();
        showPlay();

        state.status = 'playing';
        setOverlay(null);
        seedBubbles();
        startLoop();

        updateControls();
        updateHud();
    }

    function pauseGame() {
        if (state.status !== 'playing') return;

        state.status = 'paused';
        stopLoop();
        setOverlay('pause');
        updateControls();
    }

    function resumeGame() {
        if (state.status !== 'paused') return;

        state.status = 'playing';
        setOverlay(null);
        startLoop();
        updateControls();
    }

    function togglePause() {
        if (state.status === 'playing') pauseGame();
        else if (state.status === 'paused') resumeGame();
    }

    // Ends the round: stops the loop, freezes bubbles and shows Round over
    function endGame(reason) {
        if (state.status !== 'playing' && state.status !== 'paused') return;

        state.status = 'over';
        state.overReason = reason;
        stopLoop();

        dom.overReason.textContent = reason;
        dom.overScore.textContent = state.score.toLocaleString();
        setOverlay('over');
        playTone(440, 0.9, 'triangle', 0.09, 110);

        updateControls();
        updateHud();
    }

    // Performance message from accuracy and misses
    function performanceMessage(accuracy, attempts) {
        if (attempts === 0) return 'The round ended before the first bubble';
        if (accuracy === 100 && state.misses === 0) return 'Flawless round';
        if (accuracy >= 85) return 'Sharp, focused play';
        if (accuracy >= 65) return 'Steady rhythm. Push for fewer misses';
        return 'Every round sharpens recognition';
    }

    // Shows the results screen with the final statistics
    function showResults() {
        if (state.status !== 'over') return;

        const attempts = state.correct + state.wrong + state.misses;
        const accuracy = attempts ? Math.round((state.correct / attempts) * 100) : 0;
        const diff = currentDifficulty();

        state.status = 'results';
        dom.resMessage.textContent = performanceMessage(accuracy, attempts);
        dom.resSetLine.textContent = `${diff.label} difficulty · ${diff.seconds} seconds`;
        dom.resReason.textContent = state.overReason;
        dom.resScore.textContent = state.score.toLocaleString();
        dom.resCorrect.textContent = state.correct;
        dom.resWrong.textContent = state.wrong;
        dom.resMisses.textContent = state.misses;
        dom.resCombo.textContent = state.bestCombo;
        dom.resAccuracy.textContent = `${accuracy}%`;

        setOverlay('results');
        updateControls();
    }

    // Full reset: back to the launch screen with nothing left over
    function resetGame() {
        showLaunch();
    }

    // Difficulty can be chosen only on the launch screen
    function setDifficulty(key) {
        if (state.status !== 'ready' || !CONFIG.difficulties[key]) return;

        state.difficulty = key;
        state.timeLeft = currentDifficulty().seconds;
        updateLaunch();
        updateHud();
    }

    // Shows exactly one overlay (or none) and moves focus to its main button
    const OVERLAY_FOCUS = { pause: 'btnResume', over: 'btnSeeResults', results: 'btnPlayAgain' };

    function setOverlay(name) {
        Object.entries(dom.overlays).forEach(([key, el]) => {
            el.classList.toggle('is-visible', key === name);
        });

        if (name && OVERLAY_FOCUS[name]) {
            dom[OVERLAY_FOCUS[name]].focus({ preventScroll: true });
        }
    }

    /* ------------------------------------------------------------------------
       10. LAUNCH SCREEN – difficulty cards built from CONFIG
       ------------------------------------------------------------------------ */

    // Builds the difficulty cards once. Their text comes from CONFIG, so the
    // numbers shown always match the rules that are really applied.
    function buildDifficultyCards() {
        // Meters are scaled against the largest value in the game, so a full bar
        // means "the hardest setting" for that measure.
        const maxSpeed = Math.max(...Object.values(CONFIG.difficulties).map((d) => d.speed));
        const maxSeconds = Math.max(...Object.values(CONFIG.difficulties).map((d) => d.seconds));
        const maxActive = Math.max(...Object.values(CONFIG.difficulties).map((d) => d.maxActive));

        dom.diffGrid.innerHTML = Object.entries(CONFIG.difficulties).map(([key, d]) => `
      <button type="button" class="br-diff" role="radio" aria-checked="false"
              data-diff="${key}" data-accent="${d.accent}">
        <span class="br-diff-main">
          <span class="br-diff-level">Level ${d.level}</span>
          <strong>${d.label}</strong>
          <span class="br-diff-tag">${d.tagline}</span>
        </span>
        <span class="br-meters" aria-hidden="true">
          <span class="br-meter"><small>Duration</small><b>${d.seconds}s</b><i style="--fill: ${Math.round((d.seconds / maxSeconds) * 100)}%"></i></span>
          <span class="br-meter"><small>Bubble speed</small><b>${d.rise}</b><i style="--fill: ${Math.round((d.speed / maxSpeed) * 100)}%"></i></span>
          <span class="br-meter"><small>Max bubbles</small><b>${d.maxActive}</b><i style="--fill: ${Math.round((d.maxActive / maxActive) * 100)}%"></i></span>
        </span>
        <span class="br-diff-check" aria-hidden="true"><i class="bi bi-check-lg"></i></span>
      </button>`).join('');
    }

    // Decorative floating bubbles for the setup hero. Positions and sizes are
    // fixed so the composition always looks intentional; CSS does the floating.
    function buildHeroField() {
        dom.heroField = document.getElementById('heroField');
        if (!dom.heroField) return;

        const layout = [
            { letter: 'A', x: 14, y: 60, size: 92, tint: 0, dur: 6.2, delay: 0, drift: 10 },
            { letter: 'K', x: 36, y: 20, size: 64, tint: 1, dur: 7.1, delay: -2, drift: -8 },
            { letter: 'M', x: 54, y: 56, size: 118, tint: 2, dur: 8.4, delay: -1, drift: 6 },
            { letter: 'R', x: 74, y: 22, size: 78, tint: 3, dur: 5.6, delay: -3, drift: -12 },
            { letter: 'Q', x: 86, y: 66, size: 58, tint: 1, dur: 6.8, delay: -4, drift: 9 },
            { letter: 'T', x: 26, y: 86, size: 48, tint: 3, dur: 5.2, delay: -2, drift: 5 },
            { letter: 'J', x: 66, y: 88, size: 70, tint: 0, dur: 7.7, delay: -5, drift: -6 }
        ];

        layout.forEach((b) => {
            const tint = CONFIG.tints[b.tint];
            const el = document.createElement('span');
            el.className = 'br-hero-bubble';
            el.textContent = b.letter;
            el.style.left = `calc(${b.x}% - ${b.size / 2}px)`;
            el.style.top = `calc(${b.y}% - ${b.size / 2}px)`;
            el.style.width = `${b.size}px`;
            el.style.height = `${b.size}px`;
            el.style.fontSize = `${Math.round(b.size * 0.42)}px`;
            el.style.setProperty('--bubble', tint.light);
            el.style.setProperty('--bubble-deep', tint.deep);
            el.style.setProperty('--ink', tint.ink);
            el.style.setProperty('--dur', `${b.dur}s`);
            el.style.setProperty('--delay', `${b.delay}s`);
            el.style.setProperty('--drift', `${b.drift}px`);
            dom.heroField.appendChild(el);
        });
    }

    // Refreshes selection state and the start summary
    function updateLaunch() {
        const diff = currentDifficulty();

        dom.diffGrid.querySelectorAll('[data-diff]').forEach((card) => {
            card.setAttribute('aria-checked', String(card.dataset.diff === state.difficulty));
        });

        dom.startSummary.textContent =
            `${diff.label} · ${diff.seconds} seconds · ${CONFIG.maxMisses} misses end the round`;
    }

    /* ------------------------------------------------------------------------
       11. HUD & CONTROLS – make the screen match the state
       ------------------------------------------------------------------------ */

    // Builds the six miss pips once; lost misses are coloured later
    function buildLifePips() {
        dom.hudLives.innerHTML = '';
        dom.lifePips = [];

        for (let i = 0; i < CONFIG.maxMisses; i += 1) {
            const pip = document.createElement('span');
            pip.className = 'br-life';
            dom.hudLives.appendChild(pip);
            dom.lifePips.push(pip);
        }
    }

    function updateHud() {
        const diff = currentDifficulty();

        if (state.score !== shown.score) {
            if (state.score > shown.score) retriggerClass(dom.hudScore, 'is-bump');
            shown.score = state.score;
        }
        if (state.combo !== shown.combo) {
            if (state.combo > 0) retriggerClass(dom.hudCombo, 'is-bump');
            shown.combo = state.combo;
        }

        dom.hudScore.textContent = state.score.toLocaleString();
        dom.hudCombo.textContent = `x${state.combo}`;
        dom.chipDiff.textContent = diff.label;
        dom.chipLevel.textContent = `Level ${state.level}`;
        dom.hudTime.textContent = formatTime(state.timeLeft);
        dom.hudTime.classList.toggle('is-warning', state.status === 'playing' && state.timeLeft <= 10);

        dom.lifePips.forEach((pip, index) => {
            pip.classList.toggle('is-lost', index < state.misses);
        });
    }

    // Enables/disables buttons and sets the Pause/Resume icon for the state
    function updateControls() {
        const active = state.status === 'playing' || state.status === 'paused';

        dom.btnPause.disabled = !active;
        dom.btnRestart.disabled = !active;

        const isPaused = state.status === 'paused';
        dom.pauseIcon.className = isPaused ? 'bi bi-play-fill' : 'bi bi-pause-fill';
        dom.btnPause.setAttribute('aria-label', isPaused ? 'Resume round' : 'Pause round');
    }

    // Short coral flash on the escape line when a bubble gets through
    function pulseEscapeLine() {
        retriggerClass(dom.escapeLine, 'is-hit');
    }

    // Whole-arena shake for a wrong keypress
    function shakeArena() {
        retriggerClass(dom.arena, 'is-shaking');
    }

    // Removes an element when its animation ends. A timer is the fallback, because
    // animationend never fires when the CSS disables animations (reduced motion).
    function removeWhenDone(el, fallbackMs) {
        const remove = () => el.remove();
        el.addEventListener('animationend', remove, { once: true });
        setTimeout(remove, fallbackMs);
    }

    // Creates a floating label at (x, y) that removes itself after its animation.
    // type: 'good' | 'bad' | 'banner'
    function showFeedback(text, type, x, y) {
        const el = document.createElement('p');
        el.className = `br-hit is-${type}`;
        el.textContent = text;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        removeWhenDone(el, 1200);
        dom.feedbackLayer.appendChild(el);
    }

    /* ------------------------------------------------------------------------
       12. SOUND – small Web Audio tones, created only after a user gesture
       ------------------------------------------------------------------------ */
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    let audioCtx = null;

    // Browsers only allow audio after a click or key press, so this is called from startGame()
    function ensureAudio() {
        if (!AudioContextClass) return;
        if (!audioCtx) audioCtx = new AudioContextClass();
        if (audioCtx.state === 'suspended') audioCtx.resume();
    }

    // A single oscillator with a quick volume fade-out
    function playTone(frequency, duration, type, volume, slideTo = null) {
        if (!state.soundOn || !audioCtx || audioCtx.state !== 'running') return;

        const at = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = type;
        osc.frequency.setValueAtTime(frequency, at);
        if (slideTo !== null) {
            osc.frequency.exponentialRampToValueAtTime(slideTo, at + duration);
        }

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
       13. EVENTS & INIT – attached exactly once, in init()
       ------------------------------------------------------------------------ */
    function onKeyDown(event) {
        // Escape pauses or resumes an active round
        if (event.key === 'Escape') {
            if (state.status === 'playing' || state.status === 'paused') {
                event.preventDefault();
                togglePause();
            }
            return;
        }

        // Ignore held-down keys and shortcuts such as Ctrl+R
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

        // Only single letters A–Z count as game input
        if (!/^[a-z]$/i.test(event.key)) return;

        handleLetter(event.key.toUpperCase());
    }

    function onVisibilityChange() {
        // Pause automatically when the player switches tabs
        if (document.hidden && state.status === 'playing') pauseGame();
    }

    // Click on a difficulty card (one delegated listener for all three cards)
    function onDiffClick(event) {
        const card = event.target.closest('[data-diff]');
        if (card) setDifficulty(card.dataset.diff);
    }

    function bindEvents() {
        dom.btnStart.addEventListener('click', startGame);
        dom.diffGrid.addEventListener('click', onDiffClick);

        dom.btnPause.addEventListener('click', togglePause);
        dom.btnRestart.addEventListener('click', startGame);
        dom.btnReset.addEventListener('click', resetGame);
        dom.btnSound.addEventListener('click', toggleSound);

        dom.btnResume.addEventListener('click', resumeGame);
        dom.btnQuit.addEventListener('click', resetGame);
        dom.btnSeeResults.addEventListener('click', showResults);
        dom.btnPlayAgain.addEventListener('click', startGame);
        dom.btnChangeSettings.addEventListener('click', resetGame);

        // Remove the one-shot animation classes when they finish
        dom.arena.addEventListener('animationend', (event) => {
            if (event.target === dom.arena) dom.arena.classList.remove('is-shaking');
        });
        dom.escapeLine.addEventListener('animationend', () => {
            dom.escapeLine.classList.remove('is-hit');
        });
        dom.hudScore.addEventListener('animationend', () => dom.hudScore.classList.remove('is-bump'));
        dom.hudCombo.addEventListener('animationend', () => dom.hudCombo.classList.remove('is-bump'));

        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    /* ------------------------------------------------------------------------
       INIT – runs once when the script loads (it is loaded with `defer`,
       so the DOM is ready by then)
       ------------------------------------------------------------------------ */
    function init() {
        cacheDom();
        buildDifficultyCards();
        buildHeroField();
        buildLifePips();
        bindEvents();

        setDifficulty(state.difficulty);
        state.status = 'ready';
        showLaunch();
    }

    init();

    // Public API (read-only summary for debugging or future features)
    return Object.freeze({
        version: '2.0.0',
        config: CONFIG
    });
})();