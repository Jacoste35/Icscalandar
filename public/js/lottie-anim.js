/* =========================================================================
   ICSLottie — intégration Lottie (illustrations vectorielles animées).
   -------------------------------------------------------------------------
   Monte une animation Lottie dans tout élément portant l'attribut
   [data-lottie="nom"] (les fichiers sont dans /anim/<nom>.json, mis en cache
   hors-ligne par le service worker). Un observateur suit le contenu injecté
   dynamiquement. Dégradation totale : si le runtime Lottie est absent ou si un
   fichier manque / est invalide, rien ne casse (le contenu de repli reste).

   Attributs :
     data-lottie="loader|success|…"   → nom du fichier /anim/<nom>.json
     data-lottie-loop="0"              → lecture unique (par défaut : boucle)
   ========================================================================= */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var cache = {}; // nom -> Promise(dataOuNull)

  function load(name) {
    if (cache[name]) return cache[name];
    cache[name] = fetch('/anim/' + name + '.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    return cache[name];
  }

  var ICSLottie = {
    on: !!window.lottie && !reduce,
    // Monte une animation nommée dans un conteneur.
    mount: function (el, name, opts) {
      if (!this.on || !el || el.__lot) return;
      el.__lot = 1;
      opts = opts || {};
      load(name).then(function (data) {
        if (!data || !el.isConnected || !window.lottie) return;
        try {
          el.__lotAnim = window.lottie.loadAnimation({
            container: el, renderer: 'svg', loop: opts.loop !== false, autoplay: true, animationData: data,
          });
        } catch (e) {}
      });
    },
    // Parcourt un scope et monte tous les [data-lottie] non encore montés.
    scan: function (scope) {
      if (!this.on) return;
      var root = (scope && scope.querySelectorAll) ? scope : document;
      var list = root.querySelectorAll('[data-lottie]');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        this.mount(el, el.getAttribute('data-lottie'), { loop: el.getAttribute('data-lottie-loop') !== '0' });
      }
      if (scope && scope.getAttribute && scope.getAttribute('data-lottie')) {
        this.mount(scope, scope.getAttribute('data-lottie'), { loop: scope.getAttribute('data-lottie-loop') !== '0' });
      }
    },
    // Animation PLEIN ÉCRAN de confirmation (gros check, croix, sablier…) jouée
    // après une action importante. Fond translucide, texte optionnel, fermeture
    // automatique à la fin (ou au clic). Repli propre si Lottie indisponible.
    //   name : 'validate' | 'error' | 'pending' | 'success' | …
    //   opts : { text, hold, sub }
    celebrate: function (name, opts) {
      opts = (typeof opts === 'string') ? { text: opts } : (opts || {});
      name = name || 'validate';
      var ov = document.createElement('div'); ov.className = 'lt-celebrate';
      var box = document.createElement('div'); box.className = 'lt-cel-box';
      var host = document.createElement('div'); host.className = 'lt-cel-anim';
      box.appendChild(host);
      if (opts.text) { var t = document.createElement('div'); t.className = 'lt-cel-text'; t.textContent = opts.text; box.appendChild(t); }
      if (opts.sub) { var sub = document.createElement('div'); sub.className = 'lt-cel-sub'; sub.textContent = opts.sub; box.appendChild(sub); }
      ov.appendChild(box); document.body.appendChild(ov);
      requestAnimationFrame(function () { ov.classList.add('show'); });
      var closed = false;
      function close() {
        if (closed) return; closed = true;
        ov.classList.remove('show');
        setTimeout(function () { try { if (host.__lotAnim && host.__lotAnim.destroy) host.__lotAnim.destroy(); } catch (e) {} if (ov.parentNode) ov.parentNode.removeChild(ov); }, 280);
      }
      ov.addEventListener('click', close);
      var hold = opts.hold != null ? opts.hold : 850;
      if (this.on && window.lottie) {
        load(name).then(function (data) {
          if (!data) { host.innerHTML = '<div class="lt-cel-fallback">✓</div>'; setTimeout(close, 1400); return; }
          try {
            var a = window.lottie.loadAnimation({ container: host, renderer: 'svg', loop: false, autoplay: true, animationData: data });
            host.__lotAnim = a;
            a.addEventListener('complete', function () { setTimeout(close, hold); });
          } catch (e) { setTimeout(close, 1400); }
        });
      } else {
        host.innerHTML = '<div class="lt-cel-fallback">✓</div>';
        setTimeout(close, 1400);
      }
      setTimeout(close, opts.max || 4500); // filet de sécurité
      return close;
    },
    // Détruit proprement les animations d'un scope (avant retrait du DOM).
    unmount: function (scope) {
      if (!scope || !scope.querySelectorAll) return;
      var list = scope.querySelectorAll('[data-lottie]');
      for (var i = 0; i < list.length; i++) { var a = list[i].__lotAnim; if (a && a.destroy) { try { a.destroy(); } catch (e) {} } }
      if (scope.__lotAnim && scope.__lotAnim.destroy) { try { scope.__lotAnim.destroy(); } catch (e) {} }
    },
  };
  window.ICSLottie = ICSLottie;
  // Raccourci global : celebrate('validate', 'Texte') depuis n'importe où.
  window.celebrate = function (name, opts) { try { return ICSLottie.celebrate(name, opts); } catch (e) { return function () {}; } };

  if (ICSLottie.on) {
    var scanAll = function () { try { ICSLottie.scan(document); } catch (e) {} };
    if (document.readyState !== 'loading') scanAll();
    else document.addEventListener('DOMContentLoaded', scanAll);
    var pending = false;
    var io = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes && muts[i].addedNodes.length) {
          if (!pending) { pending = true; requestAnimationFrame(function () { pending = false; scanAll(); }); }
          return;
        }
      }
    });
    var host = document.getElementById('app') || document.body;
    if (host) io.observe(host, { childList: true, subtree: true });
  }
})();
