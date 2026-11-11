/* ==========================================================================
 * astro.js — FAST / CRAFTS 天文与工程几何核心
 *
 * 世界坐标（右手系）：X = 东，Y = 天顶，Z = 南（北 = -Z）。单位：米。
 * 球心在原点；反射面为半径 R 的球冠，工作抛物面顶点位于 -R·d，
 * 馈源舱位于 -(R-F)·d，d 为当前指向的单位矢量。
 *
 * 所有角度内部一律用「度」，除非函数名显式说明。
 * ========================================================================== */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 场地常数
  var SITE = {
    name: 'FAST',
    lat: 25.65295182,        // WGS-84 纬度（Qian & Yue 2020，球心）
    lon: 106.85666687,       // WGS-84 经度，东经为正
    R: 300.0,                // 基准球面曲率半径 (m)
    fOverR: 0.4621,          // 焦比（Yao et al. 2020 Table 1）
    aperture: 300.0,         // 有效照明口径 (m)
    zaMax: 40.0,             // 最大天顶角 (deg)
    zaGood: 26.4,            // 效率基本不下降的天顶角 (deg)
    decMin: -14.4,           // 可观测赤纬范围 (deg)
    decMax: 65.6,
    rot23: 23.4,             // CRAFTS 19 波束阵列旋转角 (deg)
    decStep: 21.67 / 60.0,   // 相邻扫描设置的赤纬间距 (deg) = 21.67'
    etaPeak: 0.63,           // 天顶附近望远镜效率（Jiang et al. 2019）
    etaZA40: 0.45,           // ZA=40° 时的效率
    gainPeak: 16.1,          // K/Jy @ eta=0.63
    tsys: 20.0               // K
  };
  SITE.F = SITE.R * SITE.fOverR;          // 焦距 138.63 m
  SITE.focusR = SITE.R - SITE.F;          // 馈源舱轨道半径 161.37 m
  SITE.focusMeasured = 162.15;            // 实测焦面半径（Yao 2020 Table 1）

  var DEG = Math.PI / 180.0;

  // ---------------------------------------------------------------- 时间
  // UTC 毫秒 → 儒略日
  function julianDate(ms) { return ms / 86400000.0 + 2440587.5; }

  // IAU 1982 GMST（度）
  function gmst(ms) {
    var d = julianDate(ms) - 2451545.0;
    var T = d / 36525.0;
    var g = 280.46061837 + 360.98564736629 * d +
            0.000387933 * T * T - T * T * T / 38710000.0;
    return ((g % 360) + 360) % 360;
  }

  // 地方恒星时（度）
  function lst(ms, lon) {
    return ((gmst(ms) + (lon === undefined ? SITE.lon : lon)) % 360 + 360) % 360;
  }

  // 恒星时 → 时:分:秒 字符串
  function lstString(deg) {
    var h = deg / 15.0;
    var hh = Math.floor(h);
    var mm = Math.floor((h - hh) * 60);
    var ss = Math.floor((((h - hh) * 60) - mm) * 60);
    return pad(hh) + ':' + pad(mm) + ':' + pad(ss);
  }
  function pad(v) { return (v < 10 ? '0' : '') + v; }

  // 儒略年（用于岁差）
  function jyear(ms) { return 2000.0 + (julianDate(ms) - 2451545.0) / 365.25; }

  // 岁差（IAU 1976，J2000 → 给定儒略年 T 的历元），误差 <1″/世纪
  function precess(raDeg, decDeg, year) {
    var T = (year - 2000.0) / 100.0, arc = 1 / 3600.0;
    var z1 = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * arc * DEG;
    var z2 = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * arc * DEG;
    var th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * arc * DEG;
    var a = raDeg * DEG + z1, d = decDeg * DEG;
    var A = Math.cos(d) * Math.sin(a);
    var B = Math.cos(th) * Math.cos(d) * Math.cos(a) - Math.sin(th) * Math.sin(d);
    var C = Math.sin(th) * Math.cos(d) * Math.cos(a) + Math.cos(th) * Math.sin(d);
    return {
      ra: ((Math.atan2(A, B) + z2) / DEG % 360 + 360) % 360,
      dec: Math.asin(Math.max(-1, Math.min(1, C))) / DEG
    };
  }

  // ---------------------------------------------------------------- 坐标变换
  // 地平 (az 从北向东, alt) → 赤道 (ra, dec)，输入/输出均为度
  function azAltToEqu(az, alt, lstDeg, latDeg) {
    var a = az * DEG, h = alt * DEG, p = latDeg * DEG;
    var sinDec = Math.sin(h) * Math.sin(p) + Math.cos(h) * Math.cos(p) * Math.cos(a);
    var dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
    var y = -Math.sin(a) * Math.cos(h);
    var x = Math.sin(h) * Math.cos(p) - Math.cos(h) * Math.sin(p) * Math.cos(a);
    var H = Math.atan2(y, x);
    var ra = lstDeg * DEG - H;
    return { ra: ((ra / DEG) % 360 + 360) % 360, dec: dec / DEG };
  }

  // 赤道 → 地平
  function equToAzAlt(ra, dec, lstDeg, latDeg) {
    var H = (lstDeg - ra) * DEG, d = dec * DEG, p = latDeg * DEG;
    var sinAlt = Math.sin(d) * Math.sin(p) + Math.cos(d) * Math.cos(p) * Math.cos(H);
    var alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    var y = -Math.cos(d) * Math.sin(H);
    var x = Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.sin(p) * Math.cos(H);
    var az = Math.atan2(y, x) / DEG;
    return { az: (az % 360 + 360) % 360, alt: alt / DEG };
  }

  // 地平坐标单位矢量（世界系：x 东, y 上, z 南）
  function dirFromAzAlt(az, alt) {
    var a = az * DEG, h = alt * DEG, ch = Math.cos(h);
    return [Math.sin(a) * ch, Math.sin(h), -Math.cos(a) * ch];
  }

  function dirFromRaDec(ra, dec, lstDeg, latDeg) {
    var aa = equToAzAlt(ra, dec, lstDeg, latDeg);
    return dirFromAzAlt(aa.az, aa.alt);
  }

  // 天顶角 ↔ 高度角
  function zaToAlt(za) { return 90.0 - za; }
  function altToZa(alt) { return 90.0 - alt; }

  // 由「观测赤纬」反推指向的天顶角/方位角（子午线漂移扫描：源在中天时观测）
  function pointingForDec(dec, latDeg) {
    latDeg = latDeg === undefined ? SITE.lat : latDeg;
    return { za: Math.abs(latDeg - dec), az: dec >= latDeg ? 0.0 : 180.0 };
  }

  // 由指向 (za, az) 求该指向在中天时刻的赤纬（只对子午面内的 ±za 有效）
  function decForPointing(za, az, latDeg) {
    latDeg = latDeg === undefined ? SITE.lat : latDeg;
    var north = (az < 90 || az > 270);          // 指向偏北
    return north ? latDeg + za : latDeg - za;
  }

  // ---------------------------------------------------------------- 抛物面几何
  // 球心到抛物面上某点的距离（用于验证抛物面贴合球面的程度）
  function paraboloidPoint(rho, theta, d, F) {
    F = F || SITE.F;
    var e = tangentBasis(d);
    var s = rho * rho / (4 * F);
    var out = [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      out[i] = -SITE.R * d[i] + s * d[i] + rho * (Math.cos(theta) * e[0][i] + Math.sin(theta) * e[1][i]);
    }
    return out;
  }

  // 球面上的点（球心在原点，球冠开口朝 +d）
  function spherePoint(rho, theta, d) {
    var e = tangentBasis(d);
    var y = -Math.sqrt(Math.max(0, SITE.R * SITE.R - rho * rho));
    var out = [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      out[i] = y * d[i] + rho * (Math.cos(theta) * e[0][i] + Math.sin(theta) * e[1][i]);
    }
    return out;
  }

  // 与 d 垂直的一组正交基
  var _basisCache = { d: null, e: null };
  function tangentBasis(d) {
    var c = _basisCache.d;
    if (c && c[0] === d[0] && c[1] === d[1] && c[2] === d[2]) return _basisCache.e;
    var ref = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];  // 避免与 d 平行
    var e1 = normalize(cross(d, ref));
    var e2 = normalize(cross(d, e1));
    _basisCache = { d: d.slice(), e: [e1, e2] };
    return [e1, e2];
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function normalize(a) {
    var n = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / n, a[1] / n, a[2] / n];
  }

  // ---------------------------------------------------------------- 19 波束
  // 实测中心（Jiang et al. 2020 四历元均值），X = ΔRA·cosDec, Y = ΔDec，单位 arcmin
  var BEAM_OFFSETS = [
    ['M01', 0.00, 0.00], ['M02', 5.76, -0.01], ['M03', 2.86, -4.98],
    ['M04', -2.89, -5.01], ['M05', -5.78, -0.02], ['M06', -2.92, 4.98],
    ['M07', 2.85, 4.97], ['M08', 11.55, -0.02], ['M09', 8.65, -5.01],
    ['M10', 5.78, -10.02], ['M11', 0.00, -10.04], ['M12', -5.78, -10.07],
    ['M13', -8.67, -5.05], ['M14', -11.61, -0.02], ['M15', -8.68, 4.99],
    ['M16', -5.83, 10.02], ['M17', -0.03, 10.00], ['M18', 5.76, 10.00],
    ['M19', 8.63, 4.98]
  ];

  // 焦平面 FWHM（arcmin, @1.42 GHz）与相对效率（Chen et al. 2025 Table 2）
  var BEAM_FWHM = {
    M01: 2.91, M02: 2.95, M03: 2.96, M04: 2.95, M05: 2.90, M06: 2.91, M07: 2.90,
    M08: 3.03, M09: 3.01, M10: 3.02, M11: 2.98, M12: 3.02, M13: 2.95,
    M14: 2.96, M15: 2.93, M16: 2.98, M17: 3.00, M18: 2.97, M19: 2.98
  };
  var BEAM_EFF = {
    M01: 1.00, M02: 0.96, M03: 0.97, M04: 0.96, M05: 0.96, M06: 0.93, M07: 0.97,
    M08: 0.95, M09: 0.96, M10: 0.92, M11: 0.92, M12: 0.91, M13: 0.94,
    M14: 0.89, M15: 0.91, M16: 0.90, M17: 0.95, M18: 0.91, M19: 0.94
  };

  // 绕焦平面中心旋转后的偏移（arcmin）
  function rotatedOffsets(rotDeg) {
    var c = Math.cos(rotDeg * DEG), s = Math.sin(rotDeg * DEG);
    return BEAM_OFFSETS.map(function (b) {
      return { id: b[0], x: b[1] * c - b[2] * s, y: b[1] * s + b[2] * c };
    });
  }

  // 给定天顶指向 (ra0, dec0)，返回 19 束的 (ra, dec)
  function beamRaDec(ra0, dec0, rotDeg, offsetsRotated) {
    var offs = offsetsRotated || rotatedOffsets(rotDeg === undefined ? SITE.rot23 : rotDeg);
    var cosd = Math.cos(dec0 * DEG);
    return offs.map(function (o) {
      var dra = (o.x / 60.0) / Math.max(0.08, cosd);
      return { id: o.id, ra: (ra0 + dra + 360) % 360, dec: dec0 + o.y / 60.0, dx: o.x, dy: o.y };
    });
  }

  // 频率→主瓣 FWHM（arcmin），θ ∝ 1/ν 标定于 1420 MHz
  function fwhmAtFreq(beamId, freqMHz) {
    return BEAM_FWHM[beamId] * (1420.0 / freqMHz);
  }

  // 望远镜效率随天顶角变化（Jiang et al. 2019：0.63 @ZA≤26.4°，0.45 @ZA=40°）
  function efficiency(za) {
    if (za <= SITE.zaGood) return SITE.etaPeak;
    var t = (za - SITE.zaGood) / (40.0 - SITE.zaGood);
    return SITE.etaPeak + (SITE.etaZA40 - SITE.etaPeak) * t;
  }

  // ---------------------------------------------------------------- 自检
  function selftest() {
    var out = [];
    var t = Date.UTC(2026, 10, 10, 12, 0, 0);   // 2026-11-10 12:00 UTC
    out.push(['LST(deg)', lst(t).toFixed(6)]);
    out.push(['LST', lstString(lst(t))]);
    // 天顶附近往返
    var eq = azAltToEqu(0, 64.35, lst(t), SITE.lat);
    var back = equToAzAlt(eq.ra, eq.dec, lst(t), SITE.lat);
    out.push(['roundtrip az/alt', back.az.toFixed(6) + ' / ' + back.alt.toFixed(6)]);
    // 已知天体的地平坐标
    var vg = precess(279.2347, 38.7837, jyear(t));              // Vega, J2000→date
    var aa = equToAzAlt(vg.ra, vg.dec, lst(t), SITE.lat);
    out.push(['Vega(J2000) az/alt', equToAzAlt(279.2347, 38.7837, lst(t), SITE.lat).az.toFixed(3)]);
    out.push(['Vega(precessed) az/alt', aa.az.toFixed(3) + ' / ' + aa.alt.toFixed(3)]);
    // 指向与赤纬
    var pt = pointingForDec(40.0);
    out.push(['dec=40 → za/az', pt.za.toFixed(3) + ' / ' + pt.az.toFixed(1)]);
    // 抛物面贴合球面程度
    var d = normalize([0, 1, 0]);
    var p = paraboloidPoint(150, 0, d);
    out.push(['P(ρ=150) |r|', Math.hypot(p[0], p[1], p[2]).toFixed(3) + ' (sphere R=300)']);
    out.push(['vertex y', (-SITE.R).toFixed(2) + ', focus y', (-(SITE.R - SITE.F)).toFixed(2)]);
    out.push(['f, focusR', SITE.F.toFixed(2) + ', ' + SITE.focusR.toFixed(2) +
              ' (measured ' + SITE.focusMeasured + ')']);
    // 波束偏移
    var b = beamRaDec(100, 40, SITE.rot23);
    out.push(['M08 offset', b[7].dx.toFixed(2) + ', ' + b[7].dy.toFixed(2) + ' arcmin']);
    return out;
  }

  global.Astro = {
    SITE: SITE, DEG: DEG,
    julianDate: julianDate, jyear: jyear, precess: precess, gmst: gmst, lst: lst, lstString: lstString,
    azAltToEqu: azAltToEqu, equToAzAlt: equToAzAlt,
    dirFromAzAlt: dirFromAzAlt, dirFromRaDec: dirFromRaDec,
    zaToAlt: zaToAlt, altToZa: altToZa,
    pointingForDec: pointingForDec, decForPointing: decForPointing,
    paraboloidPoint: paraboloidPoint, spherePoint: spherePoint,
    tangentBasis: tangentBasis, normalize: normalize, cross: cross,
    BEAM_OFFSETS: BEAM_OFFSETS, BEAM_FWHM: BEAM_FWHM, BEAM_EFF: BEAM_EFF,
    rotatedOffsets: rotatedOffsets, beamRaDec: beamRaDec,
    fwhmAtFreq: fwhmAtFreq, efficiency: efficiency,
    selftest: selftest
  };
})(typeof window !== 'undefined' ? window : globalThis);
