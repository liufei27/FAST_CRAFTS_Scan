/* ==========================================================================
 * main.js — FAST / CRAFTS 漂移扫描交互式三维演示 (v2)
 *
 * 关键设计：CRAFTS 的物理都发生在「角分」尺度（19 束跨 25′，波束 3′），
 * 相对 500 m 望远镜与 3 km 天球几乎不可见。因此提供「角尺度放大」k：
 * 把束偏移、轨迹间距、日步长统一放大 k 倍，相对几何完全保持，
 * 但绝对角尺度是示意的。HUD 始终显示真实值。
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.Astro, S = A.SITE;
  var DEG = Math.PI / 180;
  var SKY_R = 1500;

  var COL = {
    bg: 0x04070d,
    sphere: 0x24455a, sphereEdge: 0x2f6b8c,
    para: 0x3f86ad, paraWire: 0x8fd4f2,
    cabin: 0xd08a4a, cable: 0x8a7f6a, tower: 0x3f4a55,
    beam: 0xffc966, track: 0x35d0c8, trackM01: 0x9ff0ea,
    band: 0x2f7fa8, grid: 0x1b2c3a, star: 0xdfe9f5, ground: 0x070d16
  };

  var state = {
    utcMs: Date.UTC(2026, 10, 10, 13, 0, 0),
    playing: true, speed: 600,
    decBase: 30.0, day: 0,
    rot: S.rot23, rotOn: true,
    freq: 1420,
    mag: 3,            // 足印视觉放大
    arrayMag: 40,      // 角尺度放大（束偏移/轨迹/日步长）
    deform: 1.0,
    show: { traj: true, band: false, grid: true, wire: true, cables: true, stars: true, labels: true,
            atnf: true, crafts: true },
    view: 'overview'
  };

  var scene, camera, renderer, controls, clock;
  var dishMesh, dishWire, dishGroup, apertureRing, skyGroup, beamsGroup, footprintGroup,
      tracksGroup, bandGroup, cabinGroup, cableGroup, towerGroup, labelGroup, zenithGroup;
  var dishState = { d: [0, 1, 0], dirty: true };
  var TOWER_TOPS = [];
  var GR = { rings: 42, sectors: 108, rhoMax: 250 };

  var beamsWorld = [], centerRa = 0;

  // ------------------------------------------------------------------ 初始化
  function init() {
    var canvas = document.getElementById('gl');
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(COL.bg, 1);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.6, 14000);
    camera.position.set(1750, 1150, 2250);

    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 650, 0);
    controls.minDistance = 8;
    controls.maxDistance = 7000;
    controls.zoomSpeed = 0.9;

    clock = new THREE.Clock();

    addLights();
    buildGround();
    buildDish();
    buildTowersAndCabin();
    buildSky();
    buildBeams();
    buildDeco();

    bindUI();
    bindResize();
    applyUrlState();
    syncLabels();
    applyDataMode();
    applyProjectionShift();
    refreshAll();
    if (new URLSearchParams(location.search).get('debug')) {
      var pre = document.createElement('pre');
      pre.id = 'dbg';
      pre.style.cssText = 'position:fixed;left:0;top:0;z-index:200;color:#8ff;background:#001;font-size:11px;padding:6px';
      pre.textContent = window.__checkAlign();
      setTimeout(function () {
        pre.textContent += '\n--- after frames ---' +
          '\ntri=' + renderer.info.render.triangles +
          ' calls=' + renderer.info.render.calls +
          '\nvisible=' + trailMesh.visible +
          ' parentVisible=' + trailMesh.parent.visible +
          ' matColor=' + trailMesh.material.color.getHexString() +
          ' matVCol=' + trailMesh.material.vertexColors +
          '\nworldPos=' + trailMesh.getWorldPosition(new THREE.Vector3()).toArray().map(function(v){return v.toFixed(1);}).join(',') +
          '\nchildCount=' + skyGroup.children.length +
          '\nvert0world=' + (function () {
            var v = new THREE.Vector3().fromArray(trailMesh.geometry.attributes.position.array, 0)
              .applyMatrix4(trailMesh.matrixWorld);
            return v.toArray().map(function (x) { return x.toFixed(1); }).join(',');
          })() +
          '\nskyGroupScale=' + skyGroup.matrix.getMaxScaleOnAxis().toFixed(1) +
          '\ntriOn=' + (function () {
            trailMesh.visible = true; renderer.render(scene, camera);
            var a = renderer.info.render.triangles;
            trailMesh.visible = false; renderer.render(scene, camera);
            var b = renderer.info.render.triangles;
            trailMesh.visible = true;
            return 'on=' + a + ' off=' + b + ' diff=' + (a - b);
          })();
      }, 800);
      document.body.appendChild(pre);
    }
    animate();
  }

  function addLights() {
    scene.add(new THREE.HemisphereLight(0x93bcd8, 0x0a1018, 0.6));
    var d1 = new THREE.DirectionalLight(0xd8e8ff, 0.9); d1.position.set(700, 950, 500); scene.add(d1);
    var d2 = new THREE.DirectionalLight(0x4d7fa8, 0.4); d2.position.set(-800, 260, -700); scene.add(d2);
    scene.add(new THREE.AmbientLight(0x2a3a4a, 0.7));
  }

  // ------------------------------------------------------------------ 地面
  function buildGround() {
    var g = new THREE.Group();
    var disc = new THREE.Mesh(
      new THREE.CircleGeometry(1250, 72),
      new THREE.MeshBasicMaterial({ color: COL.ground, transparent: true, opacity: 0.55 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -303;
    g.add(disc);

    var rings = [];
    for (var k = 1; k <= 3; k++) {
      var pts = [];
      for (var i = 0; i <= 96; i++) {
        var a = i / 96 * Math.PI * 2, r = 250 * k;
        pts.push(new THREE.Vector3(Math.cos(a) * r, -302.5, Math.sin(a) * r));
      }
      rings.push(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x12222e, transparent: true, opacity: 0.7 })
      ));
    }
    rings.forEach(function (r) { g.add(r); });
    scene.add(g);
  }

  // ------------------------------------------------------------------ 反射面
  function buildDish() {
    var N = GR.rings, M = GR.sectors;
    var vcount = (N + 1) * M;
    var pos = new Float32Array(vcount * 3);
    var col = new Float32Array(vcount * 3);
    var idx = [];
    for (var i = 0; i < N; i++) {
      for (var j = 0; j < M; j++) {
        var a = i * M + j, b = i * M + (j + 1) % M;
        var c = (i + 1) * M + j, d2 = (i + 1) * M + (j + 1) % M;
        idx.push(a, c, b, b, c, d2);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);

    dishMesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      vertexColors: true, shininess: 22, specular: 0x4a7fa8,
      transparent: true, opacity: 0.82, side: THREE.DoubleSide
    }));
    scene.add(dishMesh);
    dishMesh.userData.params = { N: N, M: M, rhoMax: GR.rhoMax };

    // 球面网格
    var lines = [];
    for (var r = 1; r <= 5; r++) {
      var rho = GR.rhoMax * r / 5;
      for (var k = 0; k < 128; k++) {
        var t1 = k / 128 * Math.PI * 2, t2 = (k + 1) / 128 * Math.PI * 2;
        var p1 = sph(rho, t1), p2 = sph(rho, t2);
        lines.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
      }
    }
    for (var s = 0; s < 16; s++) {
      var th = s / 16 * Math.PI * 2;
      for (var q = 0; q < 11; q++) {
        var r1 = GR.rhoMax * q / 11, r2 = GR.rhoMax * (q + 1) / 11;
        var a1 = sph(r1, th), a2 = sph(r2, th);
        lines.push(a1[0], a1[1], a1[2], a2[0], a2[1], a2[2]);
      }
    }
    var lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    dishWire = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      color: COL.sphereEdge, transparent: true, opacity: 0.28
    }));
    scene.add(dishWire);

    // 工作抛物面（局部坐标，随指向刚体运动）
    dishGroup = new THREE.Group();
    var pw = [];
    [26, 52, 78, 104, 130, 150].forEach(function (rho) {
      for (var k2 = 0; k2 < 96; k2++) {
        var ta = k2 / 96 * Math.PI * 2, tb = (k2 + 1) / 96 * Math.PI * 2;
        var y = rho * rho / (4 * S.F);
        pw.push(new THREE.Vector3(Math.cos(ta) * rho, y, Math.sin(ta) * rho));
        pw.push(new THREE.Vector3(Math.cos(tb) * rho, y, Math.sin(tb) * rho));
      }
    });
    for (var s2 = 0; s2 < 12; s2++) {
      var th2 = s2 / 12 * Math.PI * 2;
      for (var q2 = 0; q2 < 12; q2++) {
        var ra = S.aperture / 2 * q2 / 12, rb = S.aperture / 2 * (q2 + 1) / 12;
        pw.push(new THREE.Vector3(Math.cos(th2) * ra, ra * ra / (4 * S.F), Math.sin(th2) * ra));
        pw.push(new THREE.Vector3(Math.cos(th2) * rb, rb * rb / (4 * S.F), Math.sin(th2) * rb));
      }
    }
    dishGroup.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pw),
      new THREE.LineBasicMaterial({ color: COL.paraWire, transparent: true, opacity: 0.34 })
    ));

    // 300 m 照明口径圈
    var ring = [];
    for (var m = 0; m <= 160; m++) {
      var tt = m / 160 * Math.PI * 2;
      ring.push(new THREE.Vector3(
        Math.cos(tt) * S.aperture / 2,
        Math.pow(S.aperture / 2, 2) / (4 * S.F),
        Math.sin(tt) * S.aperture / 2));
    }
    var rg = new THREE.BufferGeometry().setFromPoints(ring);
    apertureRing = new THREE.Line(rg, new THREE.LineBasicMaterial({
      color: 0x9fe0ff, transparent: true, opacity: 0.9
    }));
    dishGroup.add(apertureRing);
    scene.add(dishGroup);
  }

  function sph(rho, th) {
    var y = -Math.sqrt(Math.max(0, S.R * S.R - rho * rho));
    return [Math.cos(th) * rho, y, Math.sin(th) * rho];
  }

  function updateDish() {
    var d = dishState.d;
    var P = dishMesh.userData.params;
    var pos = dishMesh.geometry.attributes.position.array;
    var col = dishMesh.geometry.attributes.color.array;
    var f = S.F, R = S.R;

    var e = A.tangentBasis(d);
    var dz = [0, 1, 0], eb = A.tangentBasis(dz);

    var cSphere = new THREE.Color(COL.sphere);
    var cP = new THREE.Color(COL.para);

    for (var i = 0; i <= P.N; i++) {
      var rho = P.rhoMax * Math.pow(i / P.N, 0.9);
      for (var j = 0; j < P.M; j++) {
        var th = j / P.M * Math.PI * 2, k = (i * P.M + j) * 3;
        var ct = Math.cos(th), st = Math.sin(th);

        var y = -Math.sqrt(Math.max(0, R * R - rho * rho));
        var sx = y * dz[0] + rho * (ct * eb[0][0] + st * eb[1][0]);
        var sy = y * dz[1] + rho * (ct * eb[0][1] + st * eb[1][1]);
        var sz = y * dz[2] + rho * (ct * eb[0][2] + st * eb[1][2]);

        var qx = ct * e[0][0] + st * e[1][0];
        var qy = ct * e[0][1] + st * e[1][1];
        var qz = ct * e[0][2] + st * e[1][2];
        var hh = rho * rho / (4 * f);
        var px = -R * d[0] + hh * d[0] + rho * qx;
        var py = -R * d[1] + hh * d[1] + rho * qy;
        var pz = -R * d[2] + hh * d[2] + rho * qz;

        var w = 1 - THREE.MathUtils.smoothstep(rho, 138, 166);
        var t = state.deform * w;
        pos[k] = sx + (px - sx) * t;
        pos[k + 1] = sy + (py - sy) * t;
        pos[k + 2] = sz + (pz - sz) * t;

        col[k] = cSphere.r + (cP.r - cSphere.r) * t;
        col[k + 1] = cSphere.g + (cP.g - cSphere.g) * t;
        col[k + 2] = cSphere.b + (cP.b - cSphere.b) * t;
      }
    }
    dishMesh.geometry.attributes.position.needsUpdate = true;
    dishMesh.geometry.attributes.color.needsUpdate = true;
    dishMesh.geometry.computeVertexNormals();
    dishMesh.geometry.computeBoundingSphere();
    dishState.dirty = false;
  }

  // ------------------------------------------------------------------ 塔与馈源舱
  function buildTowersAndCabin() {
    towerGroup = new THREE.Group();
    var mat = new THREE.MeshPhongMaterial({ color: COL.tower, shininess: 15 });
    for (var k = 0; k < 6; k++) {
      var a = (k * 60 + 30) * DEG, r = 250;
      var baseY = -Math.sqrt(300 * 300 - r * r), h = 172;
      var t = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 4.2, h, 8), mat);
      t.position.set(Math.sin(a) * r, baseY + h / 2, -Math.cos(a) * r);
      towerGroup.add(t);
      TOWER_TOPS.push(new THREE.Vector3(t.position.x, baseY + h, t.position.z));
    }
    scene.add(towerGroup);

    cabinGroup = new THREE.Group();
    cabinGroup.add(new THREE.Mesh(new THREE.BoxGeometry(14, 12, 14),
      new THREE.MeshPhongMaterial({ color: COL.cabin, shininess: 70, specular: 0x774422 })));
    cabinGroup.add(new THREE.Mesh(new THREE.SphereGeometry(10, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.12 })));

    var coneMat = new THREE.MeshPhongMaterial({ color: 0xffe0a8, emissive: 0x664400 });
    var offs0 = A.rotatedOffsets(state.rot);
    offs0.forEach(function (o) {
      var cone = new THREE.Mesh(new THREE.ConeGeometry(1.0, 3.6, 8), coneMat);
      cone.position.set(o.x / 60 * 0.5, 7.0, o.y / 60 * 0.5);
      cone.rotation.x = Math.PI;
      cone.userData.feedOffset = o;
      cabinGroup.add(cone);
    });
    scene.add(cabinGroup);

    cableGroup = new THREE.Group();
    var arr = new Float32Array(6 * 2 * 3);
    var cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    cableGroup.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({
      color: COL.cable, transparent: true, opacity: 0.7
    })));
    cableGroup.userData.geo = cg;
    scene.add(cableGroup);
  }

  // ------------------------------------------------------------------ 天球
  function buildSky() {
    skyGroup = new THREE.Group();
    skyGroup.matrixAutoUpdate = false;
    scene.add(skyGroup);

    // 网格
    var gpts = [];
    [-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75].forEach(function (dec) {
      for (var i = 0; i < 120; i++) {
        gpts.push(eqXYZ(i / 120 * 360, dec), eqXYZ((i + 1) / 120 * 360, dec));
      }
    });
    for (var ra = 0; ra < 360; ra += 30) {
      for (var dd = -75; dd < 75; dd += 5) gpts.push(eqXYZ(ra, dd), eqXYZ(ra, dd + 5));
    }
    var flat = [];
    gpts.forEach(function (p) { flat.push(p[0], p[1], p[2]); });
    var gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    var gridObj = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({
      color: COL.grid, transparent: true, opacity: 0.85
    }));
    gridObj.name = 'grid';
    skyGroup.add(gridObj);

    // 可观测赤纬边界
    [S.decMin, S.decMax].forEach(function (dec) {
      var pts = [];
      for (var i = 0; i <= 240; i++) {
        var p = eqXYZ(i / 240 * 360, dec, 0.99);
        pts.push(new THREE.Vector3(p[0], p[1], p[2]));
      }
      var g = new THREE.BufferGeometry().setFromPoints(pts);
      var ln = new THREE.Line(g, new THREE.LineDashedMaterial({
        color: 0x5f9fc0, dashSize: 0.018, gapSize: 0.014, transparent: true, opacity: 0.5
      }));
      ln.computeLineDistances();
      skyGroup.add(ln);
    });

    // 恒星
    var sp = [], sc = [];
    BRIGHT.forEach(function (b) {
      var p = eqXYZ(b.ra, b.dec, 0.996);
      sp.push(p[0], p[1], p[2]);
      var t = Math.min(1, Math.max(0.25, (3.4 - b.mag) / 4.0));
      sc.push(0.80 + 0.2 * t, 0.86 + 0.12 * t, 1.0);
    });
    var rnd = lcg(20261110);
    for (var i2 = 0; i2 < 900; i2++) {
      var raR = rnd() * 360, decR = Math.asin(rnd() * 2 - 1) / DEG;
      var p2 = eqXYZ(raR, decR, 0.998);
      sp.push(p2[0], p2[1], p2[2]);
      sc.push(0.62, 0.70, 0.86);
    }
    var sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    var stars = new THREE.Points(sg, new THREE.PointsMaterial({
      size: 10, sizeAttenuation: true, vertexColors: true,
      map: makeDotTexture(), alphaTest: 0.03,
      transparent: true, opacity: 0.5, depthWrite: false
    }));
    stars.name = 'stars';
    skyGroup.add(stars);

    // 南北天极
    [[0, 90], [0, -90]].forEach(function (pd) {
      var pts = [];
      for (var k = 0; k < 8; k++) {
        var ang = k / 8 * Math.PI * 2;
        var r = 0.012;
        pts.push(eqXYZ(pd[0] + Math.cos(ang) * 3, pd[1] * (1 - r), 0.99));
      }
    });

    buildPulsars();

    bandGroup = new THREE.Group(); bandGroup.name = 'bands';
    skyGroup.add(bandGroup);
    tracksGroup = new THREE.Group(); tracksGroup.name = 'tracks';
    skyGroup.add(tracksGroup);
  }

  var atnfPoints = null, craftsPoints = null, dotTex = null;

  function makeDotTexture() {
    if (dotTex) return dotTex;
    var s2 = 64, c = document.createElement('canvas');
    c.width = c.height = s2;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(s2 / 2, s2 / 2, 0, s2 / 2, s2 / 2, s2 / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.20)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s2, s2);
    dotTex = new THREE.CanvasTexture(c);
    dotTex.needsUpdate = true;
    return dotTex;
  }

  function buildPulsars() {
    var P = window.PULSAR_DATA;
    if (!P) return;

    function makePoints(list, radius, mat) {
      var arr = new Float32Array(list.length * 3);
      for (var i = 0; i < list.length; i++) {
        var v = eqXYZ(list[i][0], list[i][1], radius);
        arr[i * 3] = v[0]; arr[i * 3 + 1] = v[1]; arr[i * 3 + 2] = v[2];
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      var pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      return pts;
    }

    atnfPoints = makePoints(P.atnf, 0.9975, new THREE.PointsMaterial({
      color: 0xa9cdf0, size: 17.0, sizeAttenuation: true,
      map: makeDotTexture(), alphaTest: 0.03,
      transparent: true, opacity: 1.0, depthWrite: false
    }));
    atnfPoints.name = 'atnf';
    skyGroup.add(atnfPoints);

    craftsPoints = makePoints(P.crafts, 0.9985, new THREE.PointsMaterial({
      color: 0xff5a2a, size: 28.0, sizeAttenuation: true,
      map: makeDotTexture(), alphaTest: 0.03,
      transparent: true, opacity: 1.0, depthWrite: false
    }));
    craftsPoints.name = 'craftsPulsars';
    skyGroup.add(craftsPoints);

    // 面板里显示数量
    setText('cntATNF', P.atnf.length);
    setText('cntCRAFTS', P.crafts.length);
  }

  function eqXYZ(raDeg, decDeg, r) {
    r = r === undefined ? 1 : r;
    var a = raDeg * DEG, dd = decDeg * DEG;
    return [r * Math.cos(dd) * Math.cos(a), r * Math.sin(dd), r * Math.cos(dd) * Math.sin(a)];
  }

  var _m4 = new THREE.Matrix4();
  function updateSkyMatrix(lstDeg) {
    var X = A.dirFromRaDec(0, 0, lstDeg, S.lat);
    var Y = A.dirFromAzAlt(0, S.lat);
    var Z = A.dirFromRaDec(90, 0, lstDeg, S.lat);
    var R = SKY_R;
    _m4.set(
      X[0] * R, Y[0] * R, Z[0] * R, 0,
      X[1] * R, Y[1] * R, Z[1] * R, 0,
      X[2] * R, Y[2] * R, Z[2] * R, 0,
      0, 0, 0, 1);
    skyGroup.matrix.copy(_m4);
    skyGroup.matrixWorldNeedsUpdate = true;
  }

  // ------------------------------------------------------------------ 波束
  function buildBeams() {
    beamsGroup = new THREE.Group();
    var cyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    for (var i = 0; i < 19; i++) {
      var m = new THREE.Mesh(cyl, new THREE.MeshBasicMaterial({
        color: i === 0 ? 0xfff0d0 : COL.beam,
        transparent: true, opacity: i === 0 ? 0.30 : 0.17,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      }));
      beamsGroup.add(m);
    }
    scene.add(beamsGroup);

    footprintGroup = new THREE.Group();
    var MB = window.MeasuredBeam;
    var tex = makeGlowTexture();
    for (var k = 0; k < 19; k++) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: MB ? MB.texture(k) : tex,
        color: MB ? 0xffffff : (k === 0 ? 0xffffff : COL.beam),
        transparent: true, opacity: MB ? 0.95 : (k === 0 ? 0.95 : 0.8),
        depthWrite: false, blending: THREE.AdditiveBlending
      }));
      footprintGroup.add(sp);
    }
    scene.add(footprintGroup);
  }

  function makeGlowTexture() {
    var s = 128, c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var grd = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0.0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.30, 'rgba(255,222,160,0.62)');
    grd.addColorStop(0.62, 'rgba(255,196,110,0.18)');
    grd.addColorStop(1.0, 'rgba(255,180,80,0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, s, s);
    var t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }

  // ------------------------------------------------------------------ 装饰（天顶点、标签）
  function buildDeco() {
    // 天顶虚线
    zenithGroup = new THREE.Group();
    var pts = [new THREE.Vector3(0, 120, 0), new THREE.Vector3(0, SKY_R * 0.96, 0)];
    var ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0x3a5568, dashSize: 26, gapSize: 22, transparent: true, opacity: 0.55 }));
    ln.computeLineDistances();
    zenithGroup.add(ln);
    scene.add(zenithGroup);

    // 标签
    labelGroup = new THREE.Group();
    scene.add(labelGroup);
    addLabel('馈源舱 / 焦点', 'cabin');
    addLabel('工作抛物面 300 m', 'para');
    addLabel('基准球面 500 m', 'sphere');
  }

  var labels = {};
  function addLabel(text, key) {
    var c = document.createElement('canvas');
    var ctx = c.getContext('2d');
    var pad = 8, fs = 34;
    ctx.font = '500 ' + fs + 'px "PingFang SC","Helvetica Neue",sans-serif';
    var w = ctx.measureText(text).width;
    c.width = Math.ceil(w + pad * 2); c.height = fs + pad * 2;
    ctx = c.getContext('2d');
    ctx.font = '500 ' + fs + 'px "PingFang SC","Helvetica Neue",sans-serif';
    ctx.fillStyle = 'rgba(8,16,26,0.72)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#cfe6f5';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, c.height / 2);
    var tex = new THREE.CanvasTexture(c);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false
    }));
    var scl = 15;
    sp.scale.set(c.width / c.height * scl, scl, 1);
    labels[key] = sp;
    labelGroup.add(sp);
  }

  function syncLabels() {
    if (!labels.cabin) return;
    var d = dishState.d, cab = cabinGroup.position;
    labels.cabin.position.set(cab.x + d[0] * 26 + 26, cab.y + d[1] * 26 + 14, cab.z + d[2] * 26 + 26);
    labels.para.position.set(0, -292, 150);
    labels.sphere.position.set(0, -136, 300);
    var on = state.show.labels && state.view !== 'feed';
    for (var k in labels) labels[k].visible = on;
  }

  // ------------------------------------------------------------------ 更新
  function currentPointing() {
    var want = state.decBase + state.day * S.decStep;      // 请求的观测赤纬
    var dec = Math.max(S.decMin, Math.min(S.decMax, want)); // 受 40° 天顶角限制
    var p = A.pointingForDec(dec);
    return { dec: dec, za: p.za, az: p.az, want: want, clamped: Math.abs(want - dec) > 1e-9 };
  }

  function updatePointing() {
    var pt = currentPointing();
    var d = A.dirFromAzAlt(pt.az, A.zaToAlt(pt.za));
    dishState.d = d;

    var cab = d.map(function (v) { return -S.focusR * v; });
    cabinGroup.position.set(cab[0], cab[1], cab[2]);
    cabinGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(d[0], d[1], d[2]));

    var arr = cableGroup.userData.geo.attributes.position.array;
    for (var i = 0; i < 6; i++) {
      var t = TOWER_TOPS[i];
      arr[i * 6] = t.x; arr[i * 6 + 1] = t.y; arr[i * 6 + 2] = t.z;
      arr[i * 6 + 3] = cab[0]; arr[i * 6 + 4] = cab[1] + 5; arr[i * 6 + 5] = cab[2];
    }
    cableGroup.userData.geo.attributes.position.needsUpdate = true;
    cableGroup.visible = state.show.cables;

    dishGroup.position.set(-S.R * d[0], -S.R * d[1], -S.R * d[2]);
    dishGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(d[0], d[1], d[2]));

    updateDish();
    syncLabels();
  }

  function beamDecs(pt) {
    var offs = A.rotatedOffsets(state.rotOn ? state.rot : 0);
    var k = state.arrayMag;
    return offs.map(function (o) { return pt.dec + o.y * k / 60; });
  }

  function updateBeams(lstDeg) {
    var pt = currentPointing();
    var b0 = A.azAltToEqu(pt.az, A.zaToAlt(pt.za), lstDeg, S.lat);
    centerRa = b0.ra;

    var offs = A.rotatedOffsets(state.rotOn ? state.rot : 0);
    var k = state.arrayMag;
    var cosd = Math.max(0.15, Math.cos(b0.dec * DEG));
    var cab = cabinGroup.position;
    beamsWorld.length = 0;

    var upv = new THREE.Vector3(0, 1, 0);
    for (var i = 0; i < 19; i++) {
      var o = offs[i];
      var ra = (((b0.ra + (o.x * k / 60) / cosd) % 360) + 360) % 360;
      var dec = b0.dec + o.y * k / 60;
      var dir = A.dirFromRaDec(ra, Math.max(-88, Math.min(88, dec)), lstDeg, S.lat);
      var fw = A.fwhmAtFreq(o.id, state.freq);
      beamsWorld.push({ id: o.id, dir: dir, ra: ra, dec: dec, fwhm: fw });

      // 天球上的位置只由方向决定（不能用从舱体出发的射线交点，否则产生视差）
      var end = new THREE.Vector3(dir[0] * SKY_R * 0.995,
                                  dir[1] * SKY_R * 0.995,
                                  dir[2] * SKY_R * 0.995);
      var start = new THREE.Vector3(cab.x, cab.y, cab.z);
      var mid = start.clone().add(end).multiplyScalar(0.5);
      var len = start.distanceTo(end);
      var mesh = beamsGroup.children[i];
      mesh.position.copy(mid);
      // 光柱沿「舱体 → 天球点」的弦定向（不是沿径矢），末端才能落在足印上
      var axis = end.clone().sub(start).normalize();
      mesh.quaternion.setFromUnitVectors(upv, axis);
      var rad = 2.6;
      mesh.scale.set(rad, len, rad);
    }

    for (var j = 0; j < 19; j++) {
      var sp = footprintGroup.children[j], w = beamsWorld[j];
      sp.position.set(w.dir[0] * SKY_R * 0.995,
                      w.dir[1] * SKY_R * 0.995,
                      w.dir[2] * SKY_R * 0.995);
      var MB2 = window.MeasuredBeam;
      var sz = MB2
        ? MB2.SPAN * state.mag * DEG / 60 * SKY_R
        : Math.max(0.9, w.fwhm / 60 * DEG * SKY_R * state.mag) * 2.6;
      sp.scale.set(sz, sz, 1);
      sp.visible = true;
    }
  }

  // ------------------------------------------------------------------
  // 扫描拖尾：每个波束过去 1 小时内扫过的条带，随时间渐隐
  //   t0    → 不透明（刚扫过）
  //   t0−1h → 完全透明（已消散）
  // 宽度 = 该束 FWHM（≈3′），并随角尺度 k 同步放大，否则在 ×40 下细到不可见
  var TRAIL_HOURS = 5.0;
  var TRAIL_DRA = 15.041 * TRAIL_HOURS;   // 拖尾时长内赤经变化（度）
  var TRAIL_N = 64;                        // 每条沿时间方向的段数
  var TRAIL_NC = 5;                        // 横向顶点数（软边）
  var TRAIL_W = [0.10, 0.52, 1.0, 0.52, 0.10];   // 横向权重（近似高斯）
  var TRAIL_OFF = [-1.0, -0.5, 0.0, 0.5, 1.0];   // 横向偏移（×半宽）
  var trailMesh = null, trailPos = null, trailCol = null;

  function buildTrail() {
    var vertsPer = (TRAIL_N + 1) * TRAIL_NC;
    var pos = new Float32Array(19 * vertsPer * 3);
    var col = new Float32Array(19 * vertsPer * 3);
    var idx = [];
    for (var b = 0; b < 19; b++) {
      var base = b * vertsPer;
      for (var s = 0; s < TRAIL_N; s++) {
        for (var c = 0; c < TRAIL_NC - 1; c++) {
          var a = base + s * TRAIL_NC + c;
          var d = a + TRAIL_NC;
          idx.push(a, a + 1, d, d, a + 1, d + 1);
        }
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    trailMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending
    }));
    trailMesh.name = 'trail';
    trailMesh.frustumCulled = false;
    skyGroup.add(trailMesh);
    trailPos = g.attributes.position;
    trailCol = g.attributes.color;
  }

  var TEAL = new THREE.Color(0x35d0c8);
  var TEAL_HI = new THREE.Color(0xb8f7f2);

  function updateTrail() {
    if (!trailMesh) buildTrail();
    var pt = currentPointing();
    var offs = A.rotatedOffsets(state.rotOn ? state.rot : 0);
    var k = state.arrayMag;
    var vertsPer = (TRAIL_N + 1) * TRAIL_NC;
    var haveBeams = beamsWorld.length === 19;

    for (var b = 0; b < 19; b++) {
      // 每条拖尾的 t0 就是该束当前足印所在位置（各束赤经不同，不能共用中心赤经）
      var dec = haveBeams ? beamsWorld[b].dec : pt.dec + offs[b].y * k / 60;
      var raNow = haveBeams ? beamsWorld[b].ra : centerRa;
      var halfDeg = (A.fwhmAtFreq(offs[b].id, state.freq) / 2 / 60) * k;
      var rgb = b === 0 ? TEAL_HI : TEAL;
      var base = b * vertsPer;

      for (var s = 0; s <= TRAIL_N; s++) {
        var u = s / TRAIL_N;                       // 0 = 现在, 1 = TRAIL_HOURS 前
        var ra = raNow - u * TRAIL_DRA;
        // 透明度：t0 处 0%（不透明）→ t0−1h 处 100%（完全消失）
        var alpha = 0.9 * Math.pow(1 - u, 1.3);
        for (var c = 0; c < TRAIL_NC; c++) {
          var dd = dec + halfDeg * TRAIL_OFF[c];
          var p = eqXYZ(ra, dd, 0.995);
          var vi = base + s * TRAIL_NC + c;
          trailPos.array[vi * 3] = p[0];
          trailPos.array[vi * 3 + 1] = p[1];
          trailPos.array[vi * 3 + 2] = p[2];
          var a2 = alpha * TRAIL_W[c];
          trailCol.array[vi * 3] = rgb.r * a2;
          trailCol.array[vi * 3 + 1] = rgb.g * a2;
          trailCol.array[vi * 3 + 2] = rgb.b * a2;
        }
      }
    }
    trailPos.needsUpdate = true;
    trailCol.needsUpdate = true;
  }

  function rebuildTracks() {
    if (!trailMesh) buildTrail();
    trailMesh.visible = state.show.traj;
    if (state.show.traj) updateTrail();
  }

  // 多日扫描条带：只画当前赤经 ±32° 的短弧带，逐日 +21.67′×k
  function rebuildBands() {
    while (bandGroup.children.length) {
      var c = bandGroup.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    if (!state.show.band) return;
    var pt = currentPointing();
    var k = state.arrayMag;
    var half = 10.5 * k / 60;
    var step = S.decStep * k;
    var ra0 = centerRa;

    for (var n = -3; n <= 3; n++) {
      if (n === 0) continue;
      var dec = pt.dec + n * step;
      if (dec < -88 || dec > 88) continue;
      var d1 = dec - half, d2 = dec + half;
      if (d2 > 89 || d1 < -89) continue;

      var pts = [], idx = [];
      var N = 32;
      for (var i = 0; i <= N; i++) {
        var ra = ra0 - 32 + i * 2;
        var p1 = eqXYZ(ra, d1, 0.985), p2 = eqXYZ(ra, d2, 0.985);
        pts.push(new THREE.Vector3(p1[0], p1[1], p1[2]),
                 new THREE.Vector3(p2[0], p2[1], p2[2]));
      }
      for (var j = 0; j < N; j++) {
        var a = j * 2, b = j * 2 + 1, c2 = j * 2 + 2, dd = j * 2 + 3;
        idx.push(a, c2, b, b, c2, dd);
      }
      var g = new THREE.BufferGeometry().setFromPoints(pts);
      g.setIndex(idx);
      var base = new THREE.Color(COL.band);
      var cols = [];
      for (var ci = 0; ci <= N; ci++) {
        var u = ci / N;
        var f = THREE.MathUtils.smoothstep(u, 0.0, 0.20) *
                (1 - THREE.MathUtils.smoothstep(u, 0.80, 1.0));
        var cc = base.clone().multiplyScalar(0.14 * f);
        cols.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      bandGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
      })));

    }
  }

  function applyVisibility() {
    var hideLabels = (state.view === 'feed');
    if (dishWire) dishWire.visible = state.show.wire;
    if (cableGroup) cableGroup.visible = state.show.cables;
    var st = skyGroup.getObjectByName('stars'); if (st) st.visible = state.show.stars;
    if (atnfPoints) atnfPoints.visible = state.show.atnf;
    if (craftsPoints) craftsPoints.visible = state.show.crafts;
    var gg = skyGroup.getObjectByName('grid'); if (gg) gg.visible = state.show.grid;
    if (trailMesh) trailMesh.visible = state.show.traj;
    if (bandGroup) bandGroup.visible = state.show.band;
    for (var k in labels) labels[k].visible = state.show.labels && !hideLabels;
  }

  function refreshAll() {
    updatePointing();
    var l = A.lst(state.utcMs);
    updateSkyMatrix(l);
    updateBeams(l);
    rebuildTracks();
    rebuildBands();
    lastTrackRa = centerRa;
    applyVisibility();
    updateHUD();
    drawFinder(true);
    drawTransit(true);
  }

  // ------------------------------------------------------------------ HUD
  function updateHUD() {
    var pt = currentPointing();
    var lstDeg = A.lst(state.utcMs);
    var eta = A.efficiency(pt.za);
    var d = new Date(state.utcMs);
    setText('hudUTC', d.toISOString().replace('T', ' ').slice(0, 19));
    setText('hudLST', A.lstString(lstDeg));
    setText('hudDec', pt.dec.toFixed(2) + '°');
    setText('hudZA', pt.za.toFixed(2) + '°');
    setText('hudAz', pt.az.toFixed(0) + '°');
    setText('hudRA', A.lstString(centerRa));
    setText('hudEta', (eta * 100).toFixed(0) + '%');
    setText('hudGain', (S.gainPeak * eta / S.etaPeak).toFixed(1) + ' K/Jy');

    var span = 20.0 * (state.arrayMag > 1 ? 1 : 1) / 60 + A.fwhmAtFreq('M01', state.freq) / 60;
    setText('hudFov', (20.0 / 60).toFixed(2) + '°');
    var seg = document.getElementById('magSeg');
    if (seg) {
      [].forEach.call(seg.querySelectorAll('button'), function (btn) {
        btn.classList.toggle('active', parseFloat(btn.getAttribute('data-mag')) === state.arrayMag);
      });
      var cur = document.getElementById('magCur');
      if (cur) {
        var preset = (state.arrayMag === 1 || state.arrayMag === 40);
        cur.textContent = preset ? '' : '×' + state.arrayMag;
        cur.title = preset ? '' : '自定义值（面板滑块）';
      }
    }
    var badge = document.getElementById('visBadge');
    if (badge) {
      if (pt.clamped) {
        badge.textContent = '超出可观测范围 → 限幅 ' + pt.dec.toFixed(1) + '°';
        badge.className = 'badge bad';
      } else {
        badge.textContent = '在可观测天区';
        badge.className = 'badge ok';
      }
      badge.title = 'FAST 最大天顶角 40°；在纬度 ' + S.lat.toFixed(2) +
        '° 处对应赤纬 ' + S.decMin.toFixed(1) + '° ~ +' + S.decMax.toFixed(1) + '°';
    }
    var ti = document.getElementById('timeInput');
    if (ti && document.activeElement !== ti) ti.value = d.toISOString().slice(0, 19);
  }

  function setText(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }

  // ------------------------------------------------------------------ 2D 实测合成图
  var finderCtx = null, finderKey = '';
  function drawFinder(force) {
    var cv = document.getElementById('finder');
    if (!cv) return;
    if (!finderCtx) finderCtx = cv.getContext('2d');
    var MB = window.MeasuredBeam;
    var W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
    var span = 15.0;                                  // arcmin 半径
    var scale = Math.min(W, H) / 2 / span;            // px per arcmin

    var offs = A.rotatedOffsets(state.rotOn ? state.rot : 0);
    var key = [state.rotOn, state.rot.toFixed(1), MB ? 1 : 0].join('|');
    var ctx = finderCtx;

    if (key !== finderKey || force) {
      finderKey = key;
      ctx.clearRect(0, 0, W, H);
      if (MB) {
        var centers = offs.map(function (o) { return [o.x, o.y]; });
        var hw = Math.round(W / 2), hh = Math.round(H / 2);
        var img = MB.compositeImageData(hw, hh, centers, scale / 2, { gain: 1.0 });
        if (!drawFinder._off) {
          drawFinder._off = document.createElement('canvas');
          drawFinder._off.width = hw; drawFinder._off.height = hh;
        }
        var oc = drawFinder._off;
        oc.width = hw; oc.height = hh;
        oc.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(oc, 0, 0, W, H);
      } else {
        drawGaussians(ctx, W, H, cx, cy, scale, offs);
      }
    }

    // 网格
    ctx.strokeStyle = 'rgba(140,190,220,0.10)';
    ctx.lineWidth = 1;
    for (var g = -10; g <= 10; g += 5) {
      ctx.beginPath(); ctx.moveTo(cx + g * scale, 0); ctx.lineTo(cx + g * scale, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, cy + g * scale); ctx.lineTo(W, cy + g * scale); ctx.stroke();
    }

    // 束中心与编号
    for (var i = 0; i < 19; i++) {
      var px = cx + offs[i].x * scale, py = cy - offs[i].y * scale;
      ctx.strokeStyle = i === 0 ? 'rgba(255,255,255,0.85)' : 'rgba(255,235,190,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, 1.6, 0, Math.PI * 2); ctx.stroke();
      if (state.show.labels) {
        ctx.fillStyle = i === 0 ? '#fff' : 'rgba(255,232,190,0.75)';
        ctx.font = '9px "SF Mono",Menlo,monospace';
        ctx.fillText(offs[i].id, px + 4, py - 3);
      }
    }

    // 比例尺
    ctx.strokeStyle = 'rgba(170,200,220,0.6)';
    ctx.beginPath(); ctx.moveTo(8, H - 12); ctx.lineTo(8 + 5 * scale, H - 12); ctx.stroke();
    ctx.fillStyle = 'rgba(190,215,235,0.75)';
    ctx.font = '10px "SF Mono",Menlo,monospace';
    ctx.fillText("5'", 10, H - 16);
    ctx.fillText('ΔRA·cosδ →', W - 80, 13);
    ctx.fillText('↑ Δδ', 5, 19);
  }

  function drawGaussians(ctx, W, H, cx, cy, scale, offs) {
    for (var i = 0; i < 19; i++) {
      var fw = A.fwhmAtFreq(offs[i].id, state.freq);
      var px = cx + offs[i].x * scale, py = cy - offs[i].y * scale;
      var r = Math.max(fw / 2 * scale, 1.5) * 2.2;
      var grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, i === 0 ? 'rgba(255,255,255,0.98)' : 'rgba(255,206,122,0.9)');
      grad.addColorStop(0.5, 'rgba(255,184,86,0.42)');
      grad.addColorStop(1, 'rgba(255,170,70,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ------------------------------------------------------------------ 点源穿越光变曲线
  var transitKey = '';
  function drawTransit(force) {
    var cv = document.getElementById('transit');
    if (!cv || !window.MeasuredBeam) return;
    var MB = window.MeasuredBeam;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var pt = currentPointing();
    var key = [state.rotOn, state.rot.toFixed(1), pt.dec.toFixed(2), state.arrayMag].join('|');
    if (key === transitKey && !force) return;
    transitKey = key;

    ctx.clearRect(0, 0, W, H);
    var offs = A.rotatedOffsets(state.rotOn ? state.rot : 0);

    // 源沿赤经漂移；坐标换算到「阵列中心为原点、未放大的角分网格」
    var v = 0.25 * Math.cos(pt.dec * DEG);          // arcmin / s
    var T = 70;                                      // ±s
    var NS = 141;
    var curves = [];
    var maxTotal = 1e-9;

    for (var b = 0; b < 19; b++) {
      var arr = new Float32Array(NS);
      for (var k = 0; k < NS; k++) {
        var t = -T + 2 * T * k / (NS - 1);
        var x = v * t;                              // arcmin east
        var y = 0;                                  // 源从阵列中心穿过
        // 束中心在未放大网格中的位置
        var cxb = offs[b].x, cyb = offs[b].y;
        arr[k] = MB.sample(b, x - cxb, y - cyb);
      }
      curves.push(arr);
    }
    var total = new Float32Array(NS);
    for (var k2 = 0; k2 < NS; k2++) {
      var sum = 0;
      for (var b2 = 0; b2 < 19; b2++) sum += curves[b2][k2];
      total[k2] = sum;
      if (sum > maxTotal) maxTotal = sum;
    }

    var pad = { l: 26, r: 6, t: 8, b: 16 };
    var w = W - pad.l - pad.r, h = H - pad.t - pad.b;
    function X(k) { return pad.l + w * k / (NS - 1); }
    function Y(val) { return pad.t + h * (1 - Math.min(1, val / maxTotal)); }

    // 坐标框
    ctx.strokeStyle = 'rgba(120,170,200,0.25)';
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + h); ctx.lineTo(pad.l + w, pad.t + h); ctx.stroke();

    // 19 条单束曲线
    ctx.lineWidth = 1;
    for (var b3 = 0; b3 < 19; b3++) {
      ctx.strokeStyle = b3 === 0 ? 'rgba(255,255,255,0.7)' : 'rgba(255,196,110,0.45)';
      ctx.beginPath();
      for (var k3 = 0; k3 < NS; k3++) {
        var xk = X(k3), yk = Y(curves[b3][k3]);
        k3 ? ctx.lineTo(xk, yk) : ctx.moveTo(xk, yk);
      }
      ctx.stroke();
    }
    // 合成曲线
    ctx.strokeStyle = 'rgba(90,225,215,0.95)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (var k4 = 0; k4 < NS; k4++) {
      var xk2 = X(k4), yk2 = Y(total[k4]);
      k4 ? ctx.lineTo(xk2, yk2) : ctx.moveTo(xk2, yk2);
    }
    ctx.stroke();

    // 标注
    ctx.fillStyle = 'rgba(190,215,235,0.7)';
    ctx.font = '9px "SF Mono",Menlo,monospace';
    ctx.fillText('0', 6, pad.t + h);
    ctx.fillText('t=0', pad.l + w / 2 - 8, H - 4);
    ctx.fillText('±' + T + ' s', pad.l + w - 22, H - 4);
    // 峰值时间
    var iMax = 0;
    for (var k5 = 1; k5 < NS; k5++) if (total[k5] > total[iMax]) iMax = k5;
    var tMax = -T + 2 * T * iMax / (NS - 1);
    ctx.fillStyle = 'rgba(90,225,215,0.95)';
    ctx.fillText('峰值 ' + total[iMax].toFixed(1) + ' K/Jy', pad.l + 4, pad.t + 9);
    ctx.fillText(tMax.toFixed(0) + ' s', pad.l + w - 26, pad.t + 9);
  }

  // ------------------------------------------------------------------ 视角
  var camTween = null;
  function setView(name) {
    state.view = name;
    var pt = currentPointing(), d = dishState.d;
    var dv = new THREE.Vector3(d[0], d[1], d[2]);
    var cabin = dv.clone().multiplyScalar(-S.focusR);
    var pos, target, up = new THREE.Vector3(0, 1, 0), fov = 50;

    if (name === 'feed') {
      pos = cabin.clone().addScaledVector(dv, -132);
      target = cabin.clone().addScaledVector(dv, 620);
      var n = A.dirFromAzAlt(0, 0);
      var dot = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
      var upv = new THREE.Vector3(n[0] - dot * d[0], n[1] - dot * d[1], n[2] - dot * d[2]);
      if (upv.length() > 0.15) up = upv.normalize();
      setArrayMag(25, false);
      setFootprintMag(1);
    } else if (name === 'sky') {
      pos = new THREE.Vector3(1700, 2100, 1700);
      target = dv.clone().multiplyScalar(520);
      setArrayMag(40, false);
    } else if (name === 'section') {
      pos = new THREE.Vector3(1250, 30, 30);
      target = new THREE.Vector3(0, -120, 0);
      setArrayMag(40, false);
    } else if (name === 'beams') {
      var c = dv.clone();
      var at = c.clone().multiplyScalar(SKY_R * 0.985);
      pos = at.clone().addScaledVector(c, -700);     // 球内仰视束簇
      target = at.clone().addScaledVector(c, 40);
      fov = 34;
      setArrayMag(40, false);
      setFootprintMag(6);
    } else {
      pos = new THREE.Vector3(1750, 1150, 2250);
      target = dv.clone().multiplyScalar(650);
      setArrayMag(40, false);
    }
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; applyProjectionShift(); }
    tweenCamera(pos, target, up, 800);
  }

  function setArrayMag(v, refresh) {
    state.arrayMag = v;
    var el = document.getElementById('arrayMag');
    if (el) el.value = v;
    setText('arrayMagVal', v === 1 ? '1（真实）' : '×' + v);
    if (refresh !== false) {
      refreshAll();
    } else {
      // 即使不整体刷新，也必须让轨迹/条带跟上新的放大倍数
      rebuildTracks();
      rebuildBands();
      lastTrackRa = centerRa;
      updateHUD();
    }
  }
  function setFootprintMag(v) {
    state.mag = v;
    var el = document.getElementById('mag');
    if (el) el.value = v;
    setText('magVal', '×' + v);
    refreshAll();
  }

  function tweenCamera(pos, target, up, ms) {
    camTween = {
      t0: performance.now(), ms: ms,
      p0: camera.position.clone(), p1: pos,
      q0: controls.target.clone(), q1: target,
      u0: camera.up.clone(), u1: up.clone()
    };
  }

  function stepTween(now) {
    if (!camTween) return;
    var k = Math.min(1, (now - camTween.t0) / camTween.ms);
    var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(camTween.p0, camTween.p1, e);
    controls.target.lerpVectors(camTween.q0, camTween.q1, e);
    camera.up.lerpVectors(camTween.u0, camTween.u1, e).normalize();
    if (k >= 1) camTween = null;
  }

  // ------------------------------------------------------------------ UI
  function bindUI() {
    var $ = function (id) { return document.getElementById(id); };
    $('btnPlay').addEventListener('click', function () {
      state.playing = !state.playing;
      this.textContent = state.playing ? '⏸ 暂停' : '▶ 播放';
      this.classList.toggle('active', state.playing);
    });
    $('speed').addEventListener('input', function () {
      state.speed = Math.pow(10, parseFloat(this.value));
      setText('speedVal', fmtSpeed(state.speed));
    });
    $('decBase').addEventListener('input', function () {
      state.decBase = parseFloat(this.value);
      setText('decBaseVal', state.decBase.toFixed(1) + '°');
      refreshAll();
    });
    $('day').addEventListener('input', function () {
      state.day = parseInt(this.value, 10);
      var eff = Math.max(S.decMin, Math.min(S.decMax, state.decBase + state.day * S.decStep));
      setText('dayVal', (state.day > 0 ? '+' : '') + state.day + '  → δ=' + eff.toFixed(2) + '°');
      refreshAll();
    });
    $('rotOn').addEventListener('change', function () { state.rotOn = this.checked; refreshAll(); });
    $('rot').addEventListener('input', function () {
      state.rot = parseFloat(this.value);
      setText('rotVal', state.rot.toFixed(1) + '°');
      refreshAll();
    });
    $('freq').addEventListener('input', function () {
      state.freq = parseFloat(this.value);
      setText('freqVal', state.freq.toFixed(0) + ' MHz');
      refreshAll();
    });
    $('arrayMag').addEventListener('input', function () {
      setArrayMag(parseFloat(this.value), true);
    });
    $('mag').addEventListener('input', function () {
      setFootprintMag(parseFloat(this.value));
    });
    $('deform').addEventListener('input', function () {
      state.deform = parseFloat(this.value);
      setText('deformVal', (state.deform * 100).toFixed(0) + '%');
      dishState.dirty = true;
      updateDish();
    });
    ['traj', 'band', 'grid', 'wire', 'cables', 'stars', 'labels', 'atnf', 'crafts'].forEach(function (k) {
      var el = $('t_' + k);
      if (!el) return;
      el.addEventListener('change', function () {
        state.show[k] = this.checked;
        applyVisibility();
        if (k === 'traj') rebuildTracks();
        if (k === 'band') rebuildBands();
      });
    });
    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-view]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        setView(b.getAttribute('data-view'));
      });
    });
    $('timeInput').addEventListener('change', function () {
      var ms = Date.parse(this.value.length <= 16 ? this.value + ':00Z' : this.value + 'Z');
      if (!isNaN(ms)) { state.utcMs = ms; refreshAll(); }
    });
    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
      var map = { Digit1: 'overview', Digit2: 'feed', Digit3: 'sky', Digit4: 'section', Digit5: 'beams' };
      if (map[e.code]) {
        var b = document.querySelector('[data-view="' + map[e.code] + '"]');
        if (b) b.click();
      }
    });
    setText('speedVal', fmtSpeed(state.speed));

    [].forEach.call(document.querySelectorAll('#magSeg button'), function (b) {
      b.addEventListener('click', function () {
        setArrayMag(parseFloat(b.getAttribute('data-mag')), true);
      });
    });
  }

  function fmtSpeed(s) {
    if (s < 90) return s.toFixed(0) + '×';
    if (s < 5400) return (s / 60).toFixed(0) + '× 分/秒';
    return (s / 3600).toFixed(1) + '× 时/秒';
  }

  // ------------------------------------------------------------------ 循环
  function animate() {
    requestAnimationFrame(animate);
    var dt = Math.min(clock.getDelta(), 0.1);
    var now = performance.now();
    if (state.playing) {
      state.utcMs += dt * state.speed * 1000;
      var l = A.lst(state.utcMs);
      updateSkyMatrix(l);
      updateBeams(l);
      updateTrail();
      var dRa = Math.abs(((centerRa - lastTrackRa + 540) % 360) - 180);
      if (dRa > 1.2) { rebuildBands(); lastTrackRa = centerRa; }
      if (now - lastHud > 120) { updateHUD(); lastHud = now; }
    }
    stepTween(now);
    controls.update();
    renderer.render(scene, camera);
  }
  var lastHud = 0, lastTrackRa = -999;

  // 有实测数据时显示"内部资料"标识；公开版自动切换为高斯模型文案
  function applyDataMode() {
    var has = !!window.MeasuredBeam;
    var badge = document.querySelector('.internal');
    if (badge) badge.style.display = has ? '' : 'none';
    var m = document.getElementById('noteBeamMeasured');
    var p2 = document.getElementById('noteBeamPublic');
    if (m) m.style.display = has ? '' : 'none';
    if (p2) p2.style.display = has ? 'none' : '';
    var cap = document.querySelector('#finderWrap .cap');
    if (cap && !has) cap.textContent = '19 个波束的相对位置（高斯模型）';
    // 公开版没有实测数据：隐藏穿越曲线画布与它的标题
    var tr = document.getElementById('transit');
    var caps = document.querySelectorAll('#finderWrap .cap');
    if (tr) tr.style.display = has ? '' : 'none';
    if (caps[1]) caps[1].style.display = has ? '' : 'none';
  }

  // 左栏占据左侧，3D 画布仍铺满全窗；通过投影矩阵的水平偏移（移轴）
  // 把画面内容右移 pw/2，使场景落在"去掉左栏后"的可视区中心
  function applyProjectionShift() {
    camera.updateProjectionMatrix();
    var panel = document.getElementById('panel');
    var pw = panel ? panel.getBoundingClientRect().right : 0;
    var W = window.innerWidth || 1;
    // 要把内容右移 pw/2 像素（NDC 为 s = pw/W）：x_ndc = m00·x/(-z) − m02
    // 同时把水平尺度乘 (1−s)，否则右移后右侧会被裁掉
    var s2 = pw / W;
    camera.projectionMatrix.elements[0] *= (1 - s2);
    camera.projectionMatrix.elements[8] = -s2;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  function bindResize() {
    window.addEventListener('resize', function () {
      camera.aspect = window.innerWidth / window.innerHeight;
      renderer.setSize(window.innerWidth, window.innerHeight);
      applyProjectionShift();
    });
  }

  function applyUrlState() {
    var q = new URLSearchParams(location.search);
    var off = (q.get('off') || '').split(',').filter(Boolean);
    if (off.length) {
      off.forEach(function (k) {
        if (k === 'ground') { scene.children.forEach(function (c) { if (c.type === 'Group' && c.children.length === 6) c.visible = false; }); return; }
        if (k in state.show) state.show[k] = false;
      });
      state.show.traj = off.indexOf('traj') < 0;
      state.show.band = off.indexOf('band') < 0;
      state.show.grid = off.indexOf('grid') < 0;
      state.show.stars = off.indexOf('stars') < 0;
    }
    if (q.get('arrayMag')) setArrayMag(parseFloat(q.get('arrayMag')), false);
    if (q.get('mag') && !q.get('view')) {
      state.mag = parseFloat(q.get('mag'));
      var elm = document.getElementById('mag');
      if (elm) elm.value = state.mag;
      setText('magVal', '×' + state.mag);
    }
    if (q.get('dec')) { state.decBase = parseFloat(q.get('dec')); }
    if (q.get('day')) {
      state.day = parseInt(q.get('day'), 10);
      var el = document.getElementById('day'); if (el) el.value = state.day;
    }
    if (q.get('about')) document.getElementById('about').classList.add('show');
    if (q.get('nohud')) {
      ['panel', 'hud', 'finderWrap', 'aboutBtn'].forEach(function (id) {
        var e = document.getElementById(id); if (e) e.style.display = 'none';
      });
    }
    if (q.get('view')) {
      var b = document.querySelector('[data-view="' + q.get('view') + '"]');
      if (b) {
        b.click();
        if (q.get('arrayMag')) setArrayMag(parseFloat(q.get('arrayMag')), false);
        if (q.get('mag')) setFootprintMag(parseFloat(q.get('mag')));
        return;
      }
    }
    setArrayMag(state.arrayMag, false);
  }

  function lcg(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  var BRIGHT = [
    [101.2872, -16.7161, -1.46], [95.9880, -52.6957, -0.74], [213.9153, 19.1824, -0.05],
    [279.2347, 38.7837, 0.03], [79.1723, 45.9980, 0.08], [78.6345, -8.2016, 0.13],
    [114.8255, 5.2250, 0.34], [88.7929, 7.4070, 0.50], [297.6958, 8.8683, 0.77],
    [68.9802, 16.5093, 0.85], [247.3519, -26.4320, 1.09], [201.2983, -11.1613, 1.04],
    [116.3290, 28.0262, 1.14], [310.3580, 45.2803, 1.25], [152.0930, 11.9672, 1.35],
    [344.4127, -29.6222, 1.16], [113.6495, 31.8883, 1.58], [81.2828, 6.3497, 1.64],
    [84.0534, -1.2019, 1.69], [165.9320, 61.7510, 1.79], [206.8852, 49.3133, 1.86],
    [37.9546, 89.2641, 1.98], [107.0978, -26.3932, 1.83], [104.6564, -28.9721, 1.50],
    [85.1897, -1.9426, 1.74], [83.0017, -0.2991, 2.25], [86.9391, -9.6696, 2.06],
    [99.4279, 16.3993, 1.93], [51.0808, 49.8612, 1.79], [47.0422, 40.9556, 2.09]
  ].map(function (b) { return { ra: b[0], dec: b[1], mag: b[2] }; });

  window.__checkAlign = function () {
    var lstDeg = A.lst(state.utcMs);
    var pt = currentPointing();
    var decs = beamDecs(pt);
    var out = ['beam  fpDec   trackDec   d(arcsec)   fpRA    trackRA0'];
    for (var i = 0; i < 19; i++) {
      var p = footprintGroup.children[i].position;
      var n = Math.hypot(p.x, p.y, p.z);
      var alt = Math.asin(p.y / n) / DEG;
      var az = Math.atan2(p.x, -p.z) / DEG;
      var e = A.azAltToEqu((az + 360) % 360, alt, lstDeg, S.lat);
      var d = (e.dec - decs[i]) * 3600;
      out.push(beamsWorld[i].id + ' ' + e.dec.toFixed(3) + '  ' + decs[i].toFixed(3) +
               '  ' + d.toFixed(1) + '   ' + e.ra.toFixed(2) + '  ' + centerRa.toFixed(2));
    }
    out.push('--- trail ---');
    out.push('trailMesh=' + (trailMesh ? 'yes' : 'no') +
             ' visible=' + (trailMesh && trailMesh.visible) +
             ' verts=' + (trailMesh ? trailMesh.geometry.attributes.position.count : 0) +
             ' index=' + (trailMesh ? trailMesh.geometry.index.count : 0) +
             ' inScene=' + (trailMesh && trailMesh.parent ? trailMesh.parent.name || 'skyGroup?' : 'none'));
    if (trailMesh) {
      var pa = trailMesh.geometry.attributes.position.array;
      var ca = trailMesh.geometry.attributes.color.array;
      out.push('v0 ' + pa[0].toFixed(2) + ',' + pa[1].toFixed(2) + ',' + pa[2].toFixed(2) +
               '  c0 ' + ca[0].toFixed(3) + ',' + ca[1].toFixed(3) + ',' + ca[2].toFixed(3));
      out.push('v1 ' + pa[3].toFixed(2) + ',' + pa[4].toFixed(2) + ',' + pa[5].toFixed(2));
    }
    out.push('--- sprite vs beam-end ---');
    for (var j = 0; j < 3; j++) {
      var sp2 = footprintGroup.children[j];
      var m2 = beamsGroup.children[j];
      var ax = new THREE.Vector3(0, 1, 0).applyQuaternion(m2.quaternion).multiplyScalar(m2.scale.y / 2);
      var tip = m2.position.clone().add(ax);
      out.push(beamsWorld[j].id +
        ' sprite ' + sp2.position.toArray().map(function(v){return v.toFixed(1);}).join(',') +
        ' | tip ' + tip.toArray().map(function(v){return v.toFixed(1);}).join(',') +
        ' | d=' + sp2.position.distanceTo(tip).toFixed(2) + ' m');
    }
    return out.join('\n');
  };

  window.addEventListener('DOMContentLoaded', function () {
    try { init(); } catch (err) {
      var d = document.createElement('pre');
      d.style.cssText = 'position:fixed;z-index:99;left:0;top:0;margin:0;color:#ff8a8a;background:#12040a;padding:8px;font-size:11px;white-space:pre-wrap';
      d.textContent = 'INIT ERROR: ' + err.message + '\n' + err.stack;
      document.body.appendChild(d);
    }
  });
})();
