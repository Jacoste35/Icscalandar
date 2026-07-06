/* =========================================================================
   ICS3D — scène 3D (Three.js) pour l'écran de démarrage.
   -------------------------------------------------------------------------
   Un petit convoi de camions de livraison low-poly roule sur une route qui
   défile, éclairé + ombres portées, en toile de fond du logo. 100 % local
   (three.min.js vendé). Repli TOTAL : si Three.js est absent, si le WebGL
   n'est pas disponible, ou en mode réduction d'animations, startSplash()
   renvoie false et l'on garde le splash 2D (camions GSAP).
   ========================================================================= */
(function () {
  'use strict';
  var ICS3D = {
    _raf: null, _renderer: null, _onResize: null, _running: false,

    startSplash: function (splashEl) {
      try {
        if (!window.THREE) return false;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        // Test WebGL réel.
        var probe = document.createElement('canvas');
        var gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
        if (!gl) return false;

        var host = splashEl || document.getElementById('splash');
        if (!host) return false;
        var W = host.clientWidth || window.innerWidth;
        var H = host.clientHeight || window.innerHeight;

        var canvas = document.createElement('canvas');
        canvas.className = 'sp-3d';
        host.insertBefore(canvas, host.firstChild);
        host.classList.add('three');

        var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(W, H, false);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;

        var scene = new THREE.Scene();
        scene.fog = new THREE.Fog(0x0b1f3a, 20, 62);

        var camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 200);
        camera.position.set(0, 5.4, 12);
        camera.lookAt(0, 1.1, -6);

        // Lumières : ambiance ciel/sol + soleil rasant avec ombres.
        scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x0b1f3a, 0.95));
        var sun = new THREE.DirectionalLight(0xffffff, 1.15);
        sun.position.set(-9, 15, 7);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.camera.near = 1; sun.shadow.camera.far = 70;
        sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
        sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
        scene.add(sun);

        // Route.
        var road = new THREE.Mesh(
          new THREE.PlaneGeometry(44, 150),
          new THREE.MeshStandardMaterial({ color: 0x16305a, roughness: 0.96, metalness: 0.0 })
        );
        road.rotation.x = -Math.PI / 2; road.position.z = -42; road.receiveShadow = true;
        scene.add(road);

        // Marquage central (pointillés qui défilent).
        var dashes = new THREE.Group(); scene.add(dashes);
        var dashMat = new THREE.MeshStandardMaterial({ color: 0xdfe9ff, emissive: 0x2f4d7c, roughness: 0.6 });
        var dashGeo = new THREE.BoxGeometry(0.42, 0.05, 2.4);
        for (var d = 0; d < 42; d++) {
          var dm = new THREE.Mesh(dashGeo, dashMat);
          dm.position.set(0, 0.03, -d * 4);
          dashes.add(dm);
        }

        // Fabrique un camion low-poly (caisse + cabine + pare-brise + bande rouge + roues).
        function makeVan(bodyColor) {
          var g = new THREE.Group();
          var bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5, metalness: 0.12 });
          var box = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 3.0), bodyMat);
          box.position.set(0, 1.15, -0.3); box.castShadow = true; g.add(box);
          var cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.2, 1.15), bodyMat);
          cab.position.set(0, 0.9, 1.55); cab.castShadow = true; g.add(cab);
          var glass = new THREE.Mesh(
            new THREE.BoxGeometry(1.58, 0.72, 0.12),
            new THREE.MeshStandardMaterial({ color: 0x14427e, roughness: 0.15, metalness: 0.5 })
          );
          glass.position.set(0, 1.12, 2.14); g.add(glass);
          var stripe = new THREE.Mesh(
            new THREE.BoxGeometry(1.72, 0.34, 3.02),
            new THREE.MeshStandardMaterial({ color: 0xd9302a, roughness: 0.5 })
          );
          stripe.position.set(0, 0.66, -0.3); g.add(stripe);
          var wheelGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.32, 16);
          var wheelMat = new THREE.MeshStandardMaterial({ color: 0x0e1620, roughness: 0.85 });
          [[-0.9, 0.44, 1.35], [0.9, 0.44, 1.35], [-0.9, 0.44, -1.15], [0.9, 0.44, -1.15]].forEach(function (p) {
            var w = new THREE.Mesh(wheelGeo, wheelMat);
            w.rotation.z = Math.PI / 2; w.position.set(p[0], p[1], p[2]); w.castShadow = true; g.add(w);
          });
          return g;
        }

        var LANES = [-3.4, 0, 3.6];
        var COLORS = [0xffffff, 0xeaf1ff, 0xffffff];
        var vans = [];
        for (var v = 0; v < 3; v++) {
          var van = makeVan(COLORS[v]);
          van.position.set(LANES[v], 0, -22 - v * 15);
          van.userData.speed = 8 + v * 1.6;
          van.userData.phase = v * 1.7;
          scene.add(van);
          vans.push(van);
        }

        var clock = new THREE.Clock();
        var self = this;
        function tick() {
          self._raf = requestAnimationFrame(tick);
          var dt = Math.min(clock.getDelta(), 0.05);
          var tt = clock.elapsedTime;
          dashes.children.forEach(function (m) { m.position.z += 11 * dt; if (m.position.z > 13) m.position.z -= 168; });
          vans.forEach(function (van) {
            van.position.z += van.userData.speed * dt;
            van.position.y = Math.sin(tt * 4 + van.userData.phase) * 0.03;
            if (van.position.z > 17) { van.position.z = -74 - Math.random() * 24; }
          });
          camera.position.x = Math.sin(tt * 0.4) * 0.7;
          camera.lookAt(0, 1.1, -6);
          renderer.render(scene, camera);
        }

        this._renderer = renderer; this._running = true;
        this._onResize = function () {
          var w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
          camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false);
        };
        window.addEventListener('resize', this._onResize);
        tick();
        return true;
      } catch (e) { try { this.stop(); } catch (e2) {} return false; }
    },

    stop: function () {
      try {
        this._running = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        if (this._renderer) {
          var c = this._renderer.domElement;
          this._renderer.dispose();
          if (c && c.parentNode) c.parentNode.removeChild(c);
          this._renderer = null;
        }
      } catch (e) {}
    },
  };
  window.ICS3D = ICS3D;
})();
