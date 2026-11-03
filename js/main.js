/* ==========================================================================
   KEYVERSE – Homepage Behaviour (Vanilla JavaScript, ES6+)
   No frameworks. Bootstrap's JS bundle is loaded in index.html and exposes
   the global `bootstrap` object used for the Toast and Collapse components.

   Features in this file:
     1. Navbar glass effect on scroll
     2. Scroll-reveal animations (IntersectionObserver)
     3. Active nav link highlighting while scrolling
     4. "Coming soon" toast feedback for placeholder buttons
     5. Auto-close the mobile menu after choosing a link
     6. Footer year
     7. Mode-card cursor spotlight (fine pointers only)
     8. Interactive hero keyboard (looping key sequence + tap to press)
   ========================================================================== */

(() => {
    'use strict';

    /* ------------------------------------------------------------------------
       Shared references (queried once, reused everywhere)
       ------------------------------------------------------------------------ */
    const navbar = document.getElementById('mainNav');
    const navMenu = document.getElementById('navMenu');
    const toastEl = document.getElementById('kvToast');
    const toastMsg = document.getElementById('kvToastMessage');
    const yearEl = document.getElementById('currentYear');
    const hasIO = 'IntersectionObserver' in window;
    const reduceMo = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ------------------------------------------------------------------------
       1. NAVBAR – add a glass background once the page is scrolled
       ------------------------------------------------------------------------ */
    const SCROLL_THRESHOLD = 40; // px

    const handleNavbarScroll = () => {
        if (!navbar) return;
        navbar.classList.toggle('is-scrolled', window.scrollY > SCROLL_THRESHOLD);
    };

    // requestAnimationFrame throttles the scroll handler to one run per frame
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                handleNavbarScroll();
                ticking = false;
            });
            ticking = true;
        }
    }, { passive: true });

    handleNavbarScroll(); // run once on load in case the page starts scrolled

    /* ------------------------------------------------------------------------
       2. SCROLL REVEAL – fade/slide elements in as they enter the viewport
          Elements with [data-reveal] start hidden (.kv-reveal in style.css)
          and receive .is-visible when they first come into view.
       ------------------------------------------------------------------------ */
    const revealEls = document.querySelectorAll('[data-reveal]');

    if (hasIO) {
        revealEls.forEach((el) => el.classList.add('kv-reveal'));

        const revealObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    observer.unobserve(entry.target); // animate only once
                }
            });
        }, {
            threshold: 0.15,
            rootMargin: '0px 0px -40px 0px'
        });

        revealEls.forEach((el) => revealObserver.observe(el));
    } else {
        // Very old browsers: show everything immediately
        revealEls.forEach((el) => el.classList.add('is-visible'));
    }

    /* ------------------------------------------------------------------------
       3. ACTIVE NAV LINK – highlight the link for the section in view
       ------------------------------------------------------------------------ */
    const navLinks = document.querySelectorAll('.kv-nav-link[href^="#"]');
    const sectionIds = [...navLinks]
        .map((link) => link.getAttribute('href').slice(1))
        .filter(Boolean);

    const setActiveLink = (id) => {
        navLinks.forEach((link) => {
            const isActive = link.getAttribute('href') === `#${id}`;
            link.classList.toggle('active', isActive);
        });
    };

    if (hasIO) {
        const sections = sectionIds
            .map((id) => document.getElementById(id))
            .filter(Boolean);

        // Section 'home' is the hero (<header id="home">); the "Home" link uses #top,
        // so map the hero back to #top for highlighting.
        const activeObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    const id = entry.target.id === 'home' ? 'top' : entry.target.id;
                    setActiveLink(id);
                }
            });
        }, {
            rootMargin: '-45% 0px -50% 0px' // trigger when a section crosses the middle of the screen
        });

        sections.forEach((section) => activeObserver.observe(section));
    }

    /* ------------------------------------------------------------------------
       4. "COMING SOON" TOAST – every placeholder button gives feedback
          Any element with [data-coming-soon="Name"] shows a toast on click.
          Example: <button data-coming-soon="Bubble Rush">
       ------------------------------------------------------------------------ */
    const toast = toastEl && window.bootstrap
        ? bootstrap.Toast.getOrCreateInstance(toastEl)
        : null;

    const showComingSoon = (name) => {
        if (!toast || !toastMsg) return;
        toastMsg.textContent = `${name} is coming soon. Stay tuned!`;
        toast.show();
    };

    document.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-coming-soon]');
        if (!trigger) return;

        event.preventDefault();
        showComingSoon(trigger.dataset.comingSoon);
    });

    /* ------------------------------------------------------------------------
       5. MOBILE MENU – collapse the menu after a link is chosen
          Without this, the menu stays open over the section after navigation.
       ------------------------------------------------------------------------ */
    if (navMenu && window.bootstrap) {
        const collapse = bootstrap.Collapse.getOrCreateInstance(navMenu, { toggle: false });

        navMenu.querySelectorAll('a.nav-link, a.btn').forEach((link) => {
            link.addEventListener('click', () => {
                if (navMenu.classList.contains('show')) {
                    collapse.hide();
                }
            });
        });
    }

    /* ------------------------------------------------------------------------
       6. FOOTER YEAR – always show the current year
       ------------------------------------------------------------------------ */
    if (yearEl) {
        yearEl.textContent = new Date().getFullYear();
    }

    /* ------------------------------------------------------------------------
       7. MODE-CARD SPOTLIGHT – a soft light follows the cursor across each card.
          Only enabled on devices with a precise pointer (mouse / trackpad),
          so touch screens are unaffected.
       ------------------------------------------------------------------------ */
    const hasFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    if (hasFinePointer) {
        document.querySelectorAll('.kv-mode-card').forEach((card) => {
            card.addEventListener('pointermove', (event) => {
                const rect = card.getBoundingClientRect();
                card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
                card.style.setProperty('--my', `${event.clientY - rect.top}px`);
            });
        });
    }

    /* ------------------------------------------------------------------------
       8. INTERACTIVE HERO KEYBOARD
          a) A looping "KEYVERSE" sequence lights keys one after another.
             It only runs while the keyboard is on screen and the tab is visible,
             and it is skipped entirely for users who prefer reduced motion.
          b) Tapping or clicking a key presses it (sink + glow).
       ------------------------------------------------------------------------ */
    const heroKeyboard = document.getElementById('heroKeyboard');

    if (heroKeyboard) {
        const keyMap = new Map(
            [...heroKeyboard.querySelectorAll('.kv-keycap[data-key]')]
                .map((key) => [key.dataset.key, key])
        );

        // Adds a class for a set time, then removes it
        const flash = (keyEl, className, duration) => {
            keyEl.classList.add(className);
            window.setTimeout(() => keyEl.classList.remove(className), duration);
        };

        // b) Tap / click to press
        heroKeyboard.addEventListener('click', (event) => {
            const key = event.target.closest('.kv-keycap');
            if (!key) return;

            flash(key, 'is-pressed', 220);
            flash(key, 'is-lit', 900);
        });

        // a) Looping sequence
        if (!reduceMo && hasIO) {
            const SEQUENCE = ['K', 'E', 'Y', 'V', 'E', 'R', 'S', 'E'];
            const STEP_MS = 650;
            let step = 0;
            let timerId = null;
            let inView = false;

            const tick = () => {
                const key = keyMap.get(SEQUENCE[step % SEQUENCE.length]);
                if (key) flash(key, 'is-lit', 560);
                step += 1;
            };

            const start = () => {
                if (timerId === null) timerId = window.setInterval(tick, STEP_MS);
            };

            const stop = () => {
                if (timerId !== null) {
                    window.clearInterval(timerId);
                    timerId = null;
                }
            };

            const sync = () => {
                if (inView && !document.hidden) start();
                else stop();
            };

            const keyboardObserver = new IntersectionObserver(([entry]) => {
                inView = entry.isIntersecting;
                sync();
            }, { threshold: 0.3 });

            keyboardObserver.observe(heroKeyboard);
            document.addEventListener('visibilitychange', sync);
        }
    }
})();