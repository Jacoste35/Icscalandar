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
    // Détruit proprement les animations d'un scope (avant retrait du DOM).
    unmount: function (scope) {
      if (!scope || !scope.querySelectorAll) return;
      var list = scope.querySelectorAll('[data-lottie]');
      for (var i = 0; i < list.length; i++) { var a = list[i].__lotAnim; if (a && a.destroy) { try { a.destroy(); } catch (e) {} } }
      if (scope.__lotAnim && scope.__lotAnim.destroy) { try { scope.__lotAnim.destroy(); } catch (e) {} }
    },
  };
  window.ICSLottie = ICSLottie;

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
