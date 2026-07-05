/* =========================================================================
   ICSAnim — moteur d'animations moderne (GSAP)
   -------------------------------------------------------------------------
   Objectif : donner au site des transitions fluides et « premium » (entrées
   en cascade, apparition des cartes, pop des fenêtres, toasts glissés, compteurs
   animés, micro-interactions) SANS jamais casser l'affichage si GSAP n'a pas pu
   se charger (hors-ligne au tout premier lancement) ou si l'utilisateur a
   demandé la réduction des animations.

   Règle d'or : on n'utilise que gsap.from / fromTo qui laissent l'élément dans
   son état NATUREL à la fin. Si GSAP est absent, on ne touche à rien → le
   contenu reste visible. Aucune classe ne masque durablement le contenu.
   ========================================================================= */
(function () {
  'use strict';
  var g = window.gsap;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ON = !!g && !reduce;

  // Sous-arbres à NE PAS animer automatiquement : contenus rafraîchis en boucle
  // (géoloc temps réel, carte Leaflet) ou couches à animation propre.
  var SKIP = '#dash-geoloc, .leaflet-container, #toast-container, .modal-overlay, [data-noanim]';

  var A = {
    on: ON,
    // Anime la coquille (barre latérale + navigation) UNE SEULE FOIS, au premier
    // affichage. À chaque changement de page l'app reconstruit tout le menu ;
    // rejouer l'entrée à chaque fois donnait une impression de « flash » — on ne
    // l'anime donc plus qu'à la première ouverture.
    shell: function () {
      if (!ON || this._shellDone) return;
      this._shellDone = true;
      try {
        gsap.from('.sidebar .brand', { x: -22, opacity: 0, duration: .5, ease: 'power3.out' });
        gsap.from('.sidebar nav > *', { x: -16, opacity: 0, duration: .45, stagger: .035, delay: .04, ease: 'power3.out', clearProps: 'transform,opacity' });
        gsap.from('.sidebar .userbox', { y: 14, opacity: 0, duration: .45, delay: .18, ease: 'power3.out', clearProps: 'transform,opacity' });
        gsap.from('.bottom-nav button', { y: 26, opacity: 0, duration: .4, stagger: .05, delay: .1, ease: 'power3.out', clearProps: 'transform,opacity' });
      } catch (e) {}
    },
    // Transition d'entrée du conteneur principal à chaque changement de vue.
    view: function (main) {
      // Transition de page « slide » : le contenu glisse depuis la droite en
      // fondu. Les cartes, elles, montent (axe Y) → mouvements complémentaires.
      if (!ON || !main) return;
      try { gsap.fromTo(main, { opacity: 0, x: 26 }, { opacity: 1, x: 0, duration: .42, ease: 'power3.out', clearProps: 'transform' }); } catch (e) {}
    },
    // Parallaxe subtile du bandeau d'accueil : les couches suivent le pointeur.
    heroParallax: function (scope) {
      if (!ON) return;
      var hero = (scope || document).querySelector('.dash-hero'); if (!hero || hero.__px) return; hero.__px = 1;
      var txt = hero.querySelector('.dash-hero-text'), act = hero.querySelector('.dash-hero-actions');
      hero.addEventListener('pointermove', function (e) {
        var r = hero.getBoundingClientRect(); var dx = (e.clientX - r.left) / r.width - .5, dy = (e.clientY - r.top) / r.height - .5;
        try { gsap.to(txt, { x: dx * 18, y: dy * 10, duration: .5, ease: 'power2.out' }); gsap.to(act, { x: dx * -14, y: dy * -8, duration: .5, ease: 'power2.out' }); } catch (e2) {}
      });
      hero.addEventListener('pointerleave', function () { try { gsap.to([txt, act], { x: 0, y: 0, duration: .6, ease: 'power3.out' }); } catch (e2) {} });
    },
    // Planning : apparition en cascade des cellules du calendrier (jour, semaine,
    // mois, année, agenda). Rejoué à chaque changement de mois / de vue.
    planning: function (scope) {
      if (!ON) return;
      var g = scope || document.getElementById('cal-grid'); if (!g) return;
      try {
        var cells = g.querySelectorAll('.ioscell, .iosweek-strip > *, .iosday--solo, .agenda-item, .year-grid .cell, .month-grid .cell, .iosev');
        if (!cells.length) return;
        gsap.from(cells, { opacity: 0, y: 14, scale: .96, duration: .4, ease: 'power2.out', stagger: { amount: .5, from: 'start' }, clearProps: 'transform,opacity' });
      } catch (e) {}
    },
    // Bandeau d'accueil : titre, horloge et raccourcis en cascade.
    hero: function (scope) {
      if (!ON) return;
      var root = scope || document;
      try {
        var hero = root.querySelector('.dash-hero'); if (!hero || hero.__animd) return; hero.__animd = 1;
        var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
        tl.from('.dash-hero-text > *', { y: 18, opacity: 0, duration: .5, stagger: .08, clearProps: 'transform,opacity' })
          .from('.dash-hero-actions .hero-chip', { y: 16, opacity: 0, scale: .96, duration: .4, stagger: .05, clearProps: 'transform,opacity,scale' }, '-=.25');
      } catch (e) {}
    },
    // Apparition en cascade des blocs de contenu d'un scope (cartes, titres…).
    reveal: function (scope) {
      if (!ON) return;
      var el = scope || document.getElementById('main'); if (!el) return;
      try { revealNew(el); } catch (e) {}
    },
    // Compteurs animés : nombres des statistiques qui « défilent » jusqu'à leur
    // valeur. Ne touche qu'au 1er nœud texte numérique (l'unité reste intacte).
    count: function (scope) {
      if (!ON) return;
      var root = scope || document; if (!root.querySelectorAll) return;
      try {
        var nodes = root.querySelectorAll('.stat .value, .statcard .value, .fleet-stats .value, [data-count]');
        Array.prototype.forEach.call(nodes, function (elv) {
          if (elv.__counted) return;
          var tn = elv.firstChild;
          if (!tn || tn.nodeType !== 3) return;
          var raw = tn.textContent.trim();
          var neg = /^-/.test(raw);
          var num = raw.replace(/\s/g, '').replace(',', '.');
          if (!/^-?\d+(\.\d+)?$/.test(num)) return;
          var target = parseFloat(num); if (!isFinite(target)) return;
          var dec = (num.split('.')[1] || '').length;
          elv.__counted = 1;
          var obj = { v: 0 };
          gsap.to(obj, {
            v: target, duration: Math.min(1.1, .5 + Math.abs(target) / 400), ease: 'power2.out',
            onUpdate: function () {
              var val = dec ? obj.v.toFixed(dec) : Math.round(obj.v).toString();
              if (dec) val = val.replace('.', ',');
              tn.textContent = (neg && obj.v > 0 ? '' : '') + val + ' ';
            },
            onComplete: function () { tn.textContent = raw + ' '; },
          });
        });
      } catch (e) {}
    },
    // Ouverture d'une fenêtre modale (fond + carte).
    modalIn: function (overlay) {
      if (!ON || !overlay) return;
      try {
        var box = overlay.querySelector('.modal');
        gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: .2, ease: 'power2.out' });
        if (box) gsap.fromTo(box, { y: 24, scale: .96, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: .34, ease: 'back.out(1.5)', clearProps: 'transform' });
      } catch (e) {}
    },
    // Fermeture animée : on retire le nœud une fois l'animation terminée.
    modalOut: function (overlay, done) {
      if (!ON || !overlay) { if (done) done(); return; }
      try {
        var box = overlay.querySelector('.modal');
        var tl = gsap.timeline({ onComplete: done || function () {} });
        if (box) tl.to(box, { y: 12, scale: .97, opacity: 0, duration: .16, ease: 'power2.in' }, 0);
        tl.to(overlay, { opacity: 0, duration: .18, ease: 'power2.in' }, 0);
      } catch (e) { if (done) done(); }
    },
    // Toast : entrée glissée.
    toastIn: function (el) {
      if (!ON || !el) return;
      try { gsap.fromTo(el, { x: 40, opacity: 0, scale: .95 }, { x: 0, opacity: 1, scale: 1, duration: .35, ease: 'back.out(1.6)', clearProps: 'transform' }); } catch (e) {}
    },
    // Toast : sortie glissée puis retrait.
    toastOut: function (el, done) {
      if (!ON || !el) { if (done) done(); return; }
      try { gsap.to(el, { x: 40, opacity: 0, duration: .28, ease: 'power2.in', onComplete: done || function () {} }); } catch (e) { if (done) done(); }
    },
  };

  // --- Révélation « une seule fois » des blocs de haut niveau d'un scope ----
  function revealNew(scope) {
    var all = scope.querySelectorAll('.page-head, .dash-divider, .card, .view-switch');
    var top = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.__animd) continue;
      if (el.closest && el.closest(SKIP)) continue;
      // On n'anime que les blocs de premier niveau (pas les cartes imbriquées,
      // pour éviter les doubles fondus).
      var p = el.parentElement, nested = false;
      while (p && p !== scope) { if (p.classList && p.classList.contains('card')) { nested = true; break; } p = p.parentElement; }
      if (nested) continue;
      if (el.offsetParent === null && el.getClientRects().length === 0) continue; // masqué
      top.push(el);
    }
    if (!top.length) return;
    top.forEach(function (el) { el.__animd = 1; });
    if (top.length > 48) top = top.slice(0, 48); // garde-fou perf
    gsap.from(top, { opacity: 0, y: 22, duration: .5, stagger: .055, ease: 'power3.out', clearProps: 'transform,opacity' });
  }

  // --- Observateur global : révèle automatiquement tout nouveau contenu -----
  // (changement de vue, chargement asynchrone, changement d'onglet…). Debounced
  // via requestAnimationFrame ; ignore les sous-arbres temps réel (SKIP).
  if (ON) {
    try { document.documentElement.classList.add('gsap-on'); gsap.defaults({ ease: 'power3.out' }); } catch (e) { A.on = false; }
  }
  if (A.on) {
    var pending = false;
    function flush() {
      pending = false;
      var main = document.getElementById('main');
      if (main) { try { revealNew(main); } catch (e) {} }
    }
    var io = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type !== 'childList' || !m.addedNodes.length) continue;
        if (m.target && m.target.closest && m.target.closest(SKIP)) continue;
        if (!pending) { pending = true; requestAnimationFrame(function () { setTimeout(flush, 16); }); }
        return;
      }
    });
    function startObserver() {
      var host = document.getElementById('app') || document.body;
      if (host) io.observe(host, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver);
    else startObserver();

    // Micro-interaction : léger « appui » tactile sur les boutons.
    document.addEventListener('pointerdown', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.btn, .hero-chip, .nav-toggle') : null;
      if (!b) return;
      try { gsap.to(b, { scale: .955, duration: .09, ease: 'power2.out', yoyo: true, repeat: 1, overwrite: 'auto', clearProps: 'transform' }); } catch (err) {}
    }, { passive: true });
  }

  window.ICSAnim = A;
})();
