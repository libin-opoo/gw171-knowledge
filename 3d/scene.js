/* ==========================================================================
   GW171/6450 三维总览 —— three.js r147 (UMD)
   --------------------------------------------------------------------------
   职责：
     1. 加载 GLB 模型与部件映射表
     2. 三个预设机位（整机 / 机头 / 塔底），每个机位只开放该视角的热点
     3. 射线拾取：点击部件 -> 高亮 -> 回调原生侧
   说明：早期版本会在部件位置浮一个「资料条数」角标，用户反馈挡模型，已去掉。
        docCounts 仍会下发，只用于选中卡片上的文字（该部件已有资料 N 条）。
   与原生侧通信：
     JS -> Android : window.Android.onPartSelected(partId, name, count)
                     window.Android.onReady()
                     window.Android.onError(msg)
     Android -> JS : window.setView(id) / window.selectPart(id)
                     window.setDocCounts(json) / window.setTheme('light'|'dark')
                     window.resetCamera()
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------- 原生桥 */
  var bridge = window.Android || {
    onPartSelected: function () {},
    onReady: function () {},
    onError: function (m) { console.error('[bridge-stub]', m); },
    onBackgroundTap: function () {}
  };

  function reportError(msg) {
    try { bridge.onError(String(msg)); } catch (e) {}
    var el = document.getElementById('loading-text');
    if (el) el.textContent = '加载失败：' + msg;
    console.error(msg);
  }

  /* ------------------------------------------------------------ 机位配置 */
  // azimuth: 水平方位角(度)，0=+X，逆时针；elevation: 仰角(度)
  // radius: 需要框入视野的包围球半径(m)，实际相机距离按屏幕宽高比动态计算
  // fade:   该机位下淡化的部件（不透明会挡住内部结构）
  var VIEW_CAMERA = {
    overview:  { azimuth: 205, elevation: 14, fov: 42, radius: 100,
                 target: [0, 72, 0], fade: [] },
    nacelle:   { azimuth: 76,  elevation: 3, fov: 40, radius: 21,
                 target: [-5, 94, 0],
                 // 直驱机组的轴系、主轴承、变桨轴承都装在发电机和轮毂内部，
                 // 外罩不淡化就永远点不到里层部件；淡化后发电机仍有定子/散热筋可点。
                 fade: ['nacelle_cover', 'spinner', 'hub',
                        'generator_stator', 'generator_rotor',
                        'blade_1', 'blade_2', 'blade_3'] },
    towerbase: { azimuth: 75,  elevation: 15, fov: 45, radius: 11,
                 target: [0, 3, 0], fade: ['tower_seg_1'] }
  };

  /**
   * 按屏幕宽高比算出能把指定半径完整框入的距离。
   * three.js 的 fov 是垂直视场角，竖屏手机上水平视野小得多，
   * 若按固定距离摆相机，171m 的叶轮会被切掉两边。
   */
  function fitDistance(radius, fovDeg, aspect) {
    var vFov = fovDeg * Math.PI / 180;
    var hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    var f = Math.min(vFov, hFov);          // 取较小的那个，保证两个方向都装得下
    return radius / Math.sin(f / 2) * 1.06; // 1.06 留一点边距
  }

  var THEME = {
    // 背景刻意用中调子：机组本体是白色/浅灰，背景太亮会糊成一片没有轮廓
    light: { bg: 0xa9c1d8, hemiSky: 0xdceaf6, hemiGround: 0x6a7f92, hemi: 0.62,
             dir: 1.05, ambient: 0.30, sea: 0x5e90b8, seaOpacity: 0.62,
             seaRough: 0.22, seaMetal: 0.35, seaEnv: 0.65 },
    // 深色模式下海面要给足暗度：它面积占屏幕一大半，
    // 用和浅色模式同一套反光参数会亮得像块白板
    dark:  { bg: 0x11171f, hemiSky: 0x39506b, hemiGround: 0x1a2027, hemi: 0.42,
             dir: 0.60, ambient: 0.16, sea: 0x16323f, seaOpacity: 0.88,
             seaRough: 0.62, seaMetal: 0.08, seaEnv: 0.30 }
  };

  // 资产版本号：替换模型或映射表后递增，浏览器就会重新拉取而不是用缓存里的旧版本。
  var ASSET_VERSION = '12';

  var FADE_OPACITY = 0.11;
  var HIGHLIGHT_EMISSIVE = 0x2f7fd0;

  // 交互调试日志开关：排查点选问题时置 true，正常使用保持 false 以免刷屏。
  // 热点可达性自检 window.__audit() 不受此开关影响。
  var DEBUG_PICK = false;

  /* ------------------------------------------------------------ 运行状态 */
  var renderer, scene, camera, controls, raycaster;
  var map = null;                 // model-map.json
  var meshRegistry = {};          // nodeName -> THREE.Mesh
  var baseMaterial = {};          // nodeName -> {color, roughness, metalness}
  var currentView = 'overview';
  var pickable = [];              // 当前机位可拾取的 Mesh 列表
  var docCounts = {};             // partId -> 资料条数（只用于选中卡片上的文字）
  var selected = null;            // { mesh, node, partId, name, point }
  var needsRender = true;
  var theme = 'light';
  var lights = {};
  var seaMesh = null;
  var lastFitAspect = 0;    // 上次计算相机距离时的宽高比
  var userMoved = false;    // 用户是否手动动过相机
  var envRT = null;         // 环境贴图的 render target
  var meshToPart = {};      // 网格节点名 → 部件 ID

  /* ------------------------------------------------------------ 初始化 */
  function init() {
    var canvas = document.getElementById('stage');

    // WebGL 可用性检查：模拟器/低端机上 WebGL 可能被禁用，
    // 这种情况要明确报出来，而不是留一块空白。
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    } catch (e) {
      reportError('WebGL 不可用（' + (e && e.message ? e.message : e) + '）');
      return;
    }
    var gl = renderer.getContext();
    if (!gl) {
      reportError('WebGL 上下文创建失败');
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // updateStyle=true：显式把 CSS 像素尺寸写到 style 上，不依赖百分比高度解析
    renderer.setSize(window.innerWidth, window.innerHeight, true);
    if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.5, 6000);
    raycaster = new THREE.Raycaster();

    // 环境贴图（IBL）：MeshStandardMaterial 在 metalness 偏高又没有环境可反射时
    // 会渲染成近黑色。用程序生成的室内环境做一次 PMREM，材质才有正常的明暗层次。
    if (THREE.RoomEnvironment && THREE.PMREMGenerator) {
      try {
        var pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        envRT = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04);
        scene.environment = envRT.texture;
        pmrem.dispose();
        console.log('[diag] 环境贴图已生成');
      } catch (e) {
        console.warn('环境贴图生成失败，退回纯光照:', e);
      }
    }

    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.rotateSpeed = 0.62;
    controls.zoomSpeed = 0.85;
    controls.panSpeed = 0.6;
    controls.screenSpacePanning = true;
    controls.minDistance = 4;
    controls.maxDistance = 1400;
    controls.maxPolarAngle = Math.PI * 0.96;   // 允许看到基础以下
    controls.addEventListener('start', function () { userMoved = true; });

    applyTheme(theme);
    bindInput(canvas);
    window.addEventListener('resize', onResize);

    var dbg = renderer.capabilities && renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1';
    console.log('[diag] 渲染器就绪 ' + dbg +
      ' vsync=' + (renderer.getContext().getParameter ? 'ok' : 'n/a'));

    loadData();
    requestAnimationFrame(loop);
  }

  /** 诊断输出：在 logcat 里以 [INFO:CONSOLE] 出现，用于排查空白画面 */
  function diag(tag) {
    if (!renderer) return;
    var c = renderer.domElement;
    var f = function (v) { return v.toFixed(1); };
    var msg = '[diag:' + tag + ']' +
      ' canvas=' + c.width + 'x' + c.height +
      ' css=' + c.clientWidth + 'x' + c.clientHeight +
      ' win=' + window.innerWidth + 'x' + window.innerHeight +
      ' dpr=' + (window.devicePixelRatio || 1) +
      ' meshes=' + Object.keys(meshRegistry).length +
      ' pickable=' + pickable.length +
      ' cam=[' + camera.position.toArray().map(f).join(',') + ']' +
      ' tgt=[' + controls.target.toArray().map(f).join(',') + ']' +
      ' aspect=' + camera.aspect.toFixed(3) +
      ' near=' + camera.near.toFixed(2) + ' far=' + camera.far.toFixed(0) +
      ' drawn=' + renderer.info.render.triangles;
    console.log(msg);
  }
  window.__diag = diag;

  /* ------------------------------------------------------- 主题与灯光 */
  function applyTheme(name) {
    theme = name === 'dark' ? 'dark' : 'light';
    var t = THEME[theme];

    scene.background = new THREE.Color(t.bg);
    if (seaMesh) {
      // 海面是走着色器的网格，会经历 linear→sRGB 输出转换；
      // 而 scene.background 是直接写帧缓冲、不做转换。
      // 两者要用同一套十六进制值观感一致，网格这边必须先转成线性。
      seaMesh.material.color.setHex(t.sea).convertSRGBToLinear();
      seaMesh.material.opacity = t.seaOpacity;
      seaMesh.material.roughness = t.seaRough;
      seaMesh.material.metalness = t.seaMetal;
      seaMesh.material.envMapIntensity = t.seaEnv;
      seaMesh.material.needsUpdate = true;
    }

    if (!lights.hemi) {
      lights.hemi = new THREE.HemisphereLight(t.hemiSky, t.hemiGround, t.hemi);
      lights.dir = new THREE.DirectionalLight(0xffffff, t.dir);
      lights.dir.position.set(230, 400, 270);     // Y 轴向上：主光来自上前方
      lights.amb = new THREE.AmbientLight(0xffffff, t.ambient);
      lights.fill = new THREE.DirectionalLight(0xffffff, 0.40);
      lights.fill.position.set(-280, 150, -240);  // 背光补光，避免背面死黑
      scene.add(lights.hemi, lights.dir, lights.amb, lights.fill);
    } else {
      lights.hemi.color.setHex(t.hemiSky);
      lights.hemi.groundColor.setHex(t.hemiGround);
      lights.hemi.intensity = t.hemi;
      lights.dir.intensity = t.dir;
      lights.amb.intensity = t.ambient;
    }

    var hint = document.getElementById('hint');
    if (hint) hint.style.color = theme === 'dark' ? '#9fb4c8' : '#4a6480';
    needsRender = true;
  }

  /* -------------------------------------------------------- 数据加载 */
  function loadData() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'data/model-map.json?v=' + ASSET_VERSION, true);
    xhr.onload = function () {
      if (xhr.status !== 200 && xhr.status !== 0) {
        reportError('映射表读取失败 (' + xhr.status + ')');
        return;
      }
      try {
        map = JSON.parse(xhr.responseText);
      } catch (e) {
        reportError('映射表解析失败');
        return;
      }
      loadModel();
    };
    xhr.onerror = function () { reportError('映射表网络错误'); };
    xhr.send();
  }

  function loadModel() {
    var loader = new THREE.GLTFLoader();
    loader.load('model/turbine_gw171.glb?v=' + ASSET_VERSION, onModelLoaded, onProgress, function (err) {
      reportError('模型加载失败 ' + (err && err.message ? err.message : ''));
    });
  }

  function onProgress(evt) {
    if (evt && evt.lengthComputable && evt.total > 0) {
      var pct = Math.round(evt.loaded / evt.total * 100);
      var el = document.getElementById('loading-text');
      if (el) el.textContent = '正在加载三维模型… ' + pct + '%';
    }
  }

  function onModelLoaded(gltf) {
    var root = gltf.scene;

    // 1) 给每个节点配色，并登记到注册表
    root.traverse(function (obj) {
      if (!obj.isMesh) return;

      // 保险：模型若没带法线，光照会算出全黑（法线全零）。
      // 本项目生成的 GLB 已带法线，这里兜住将来替换成外部数模的情况。
      if (!obj.geometry.attributes.normal) {
        obj.geometry.computeVertexNormals();
        console.warn('节点 ' + obj.name + ' 缺少法线，已自动计算');
      }

      var node = findNamedAncestor(obj);
      var key = node || obj.name;
      meshRegistry[key] = obj;

      var spec = (map.colors && map.colors[key]) || map.defaultColor;
      var mat = new THREE.MeshStandardMaterial({
        // convertSRGBToLinear 必不可少：r147 默认不启用 ColorManagement，
        // 十六进制颜色会被直接当成线性值，而输出又转成 sRGB 二次提亮，
        // 结果就是所有部件都发白、饱和度尽失。转一次才还原成设计色。
        color: new THREE.Color(spec.color).convertSRGBToLinear(),
        roughness: spec.roughness !== undefined ? spec.roughness : 0.6,
        // 上限 0.5：金属度再高就接近全镜面，在手机屏幕上会显得发黑、层次差
        metalness: Math.min(spec.metalness !== undefined ? spec.metalness : 0.3, 0.5),
        envMapIntensity: 0.65,
        flatShading: false
      });
      obj.material = mat;
      obj.userData.partKey = key;
      baseMaterial[key] = { color: spec.color, roughness: mat.roughness, metalness: mat.metalness };
      obj.castShadow = false;
      obj.receiveShadow = false;
    });

    scene.add(root);
    buildSea();

    // 反向表：网格节点名 → 部件 ID。点选时用它把命中的网格翻译成部件，
    // 这样 77 个网格里的任何一个都能被正确识别，不限于 23 个热点。
    meshToPart = {};
    if (map.partMeshes) {
      for (var pid in map.partMeshes) {
        var arr = map.partMeshes[pid];
        for (var mi = 0; mi < arr.length; mi++) meshToPart[arr[mi]] = pid;
      }
    }

    setView(currentView || 'overview', true);

    var loading = document.getElementById('loading');
    if (loading) loading.classList.add('hide');

    var missing = [];
    for (var v = 0; v < map.views.length; v++) {
      var hs = map.views[v].hotspots;
      for (var h = 0; h < hs.length; h++) {
        for (var m = 0; m < hs[h].meshes.length; m++) {
          if (!meshRegistry[hs[h].meshes[m]]) missing.push(hs[h].meshes[m]);
        }
      }
    }
    if (missing.length) console.warn('模型缺少热点部件:', missing.join(', '));

    needsRender = true;
    diag('loaded');
    if (window.__auditFocus) window.__auditFocus();

    // 兜底：WebView 有时在页面加载完成时还没完成布局，画布会被算成零高度。
    // 再补设两次尺寸，确保一定能显示出来。
    if (renderer.domElement.clientHeight === 0) onResize();
    setTimeout(function () {
      if (renderer.domElement.clientHeight === 0) onResize();
      diag('t2s');
    }, 2500);
    try { bridge.onReady(); } catch (e) {}
  }

  // trimesh 导出的节点是平的，但为兼容未来的真实数模，向上找带名字的父节点
  function findNamedAncestor(obj) {
    var o = obj;
    while (o && o !== scene) {
      if (o.name && meshHasColor(o.name)) return o.name;
      o = o.parent;
    }
    return obj.name;
  }

  function meshHasColor(name) {
    return !!(map.colors && map.colors[name]);
  }

  /* ------------------------------------------------------------ 海面 */
  function buildSea() {
    var geo = new THREE.PlaneGeometry(4000, 4000);
    var t = THEME[theme];
    var mat = new THREE.MeshStandardMaterial({
      // 同上：网格色必须转线性，否则会比设定值亮一大截
      color: new THREE.Color(t.sea).convertSRGBToLinear(),
      transparent: true,
      opacity: t.seaOpacity,
      roughness: t.seaRough,
      metalness: t.seaMetal,
      envMapIntensity: t.seaEnv,
      side: THREE.DoubleSide
    });
    seaMesh = new THREE.Mesh(geo, mat);
    seaMesh.rotation.x = -Math.PI / 2;
    seaMesh.position.set(0, -14, 0);   // 塔底高于海平面 14 m
    scene.add(seaMesh);
  }

  /* --------------------------------------------------------- 机位切换 */
  function setView(viewId, silent) {
    if (!map) return;
    var view = null;
    for (var i = 0; i < map.views.length; i++) {
      if (map.views[i].id === viewId) { view = map.views[i]; break; }
    }
    if (!view) return;

    currentView = viewId;
    var cfg = VIEW_CAMERA[viewId] || VIEW_CAMERA.overview;

    // 恢复全部部件的透明度，再按本机位重新淡化。
    // 注意：运行时改 material.transparent 必须置 needsUpdate=true 触发着色器重编译，
    // 否则仍走不透明渲染路径、opacity 会被忽略。
    for (var key in meshRegistry) {
      var m = meshRegistry[key];
      if (!m || !m.material) continue;
      var wasTransparent = m.material.transparent === true;
      if (wasTransparent) {
        m.material.transparent = false;
        m.material.opacity = 1.0;
        m.material.depthWrite = true;
        m.material.needsUpdate = true;
      }
    }
    var fadedNames = {};
    for (var f = 0; f < cfg.fade.length; f++) {
      fadedNames[cfg.fade[f]] = true;
      var fm = meshRegistry[cfg.fade[f]];
      if (!fm || !fm.material) continue;
      fm.material.transparent = true;
      fm.material.opacity = FADE_OPACITY;
      fm.material.depthWrite = false;
      fm.material.needsUpdate = true;
    }

    // 重建可拾取列表：所有已注册网格中，排除本机位被淡化的（那些是透视用的外罩，
    // 挡住它们后面的内部部件会让人点不到东西）
    pickable = [];
    for (var k2 in meshRegistry) {
      if (!fadedNames[k2]) pickable.push(meshRegistry[k2]);
    }

    clearSelection();
    moveCamera(cfg);

    if (!silent) needsRender = true;
    // 机位稳定后跑一次热点可达性自检
    setTimeout(function () { if (window.__audit) window.__audit(); }, 400);
  }

  function moveCamera(cfg) {
    var az = cfg.azimuth * Math.PI / 180;
    var el = cfg.elevation * Math.PI / 180;
    // Y 轴向上（glTF 规范）：仰角指向 +Y
    var dir = new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az)
    );
    var target = new THREE.Vector3(cfg.target[0], cfg.target[1], cfg.target[2]);
    var dist = fitDistance(cfg.radius, cfg.fov, camera.aspect);
    lastFitAspect = camera.aspect;

    camera.fov = cfg.fov;
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.near = Math.max(0.3, dist / 400);
    camera.far = dist * 30;
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    controls.update();
    needsRender = true;
    userMoved = false;
  }

  /* ---------------------------------------------------------- 拾取交互 */
  var tapState = { x: 0, y: 0, t: 0, active: false };

  function bindInput(canvas) {
    canvas.addEventListener('pointerdown', function (e) {
      tapState.x = e.clientX; tapState.y = e.clientY;
      tapState.t = Date.now(); tapState.active = true;
      if (DEBUG_PICK) console.log('[diag:touch] down (' + e.clientX.toFixed(0) + ',' +
        e.clientY.toFixed(0) + ') type=' + e.pointerType);
    });

    canvas.addEventListener('pointerup', function (e) {
      if (!tapState.active) return;
      tapState.active = false;
      var dx = e.clientX - tapState.x;
      var dy = e.clientY - tapState.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var dt = Date.now() - tapState.t;
      if (DEBUG_PICK) console.log('[diag:touch] up dist=' + dist.toFixed(1) + ' dt=' + dt + 'ms');
      // 判定为「点击」而非「拖动」：位移小于 10px 且时长小于 400ms
      if (dist < 10 && dt < 400) pick(e.clientX, e.clientY);
    });

    canvas.addEventListener('pointercancel', function () {
      tapState.active = false;
      if (DEBUG_PICK) console.log('[diag:touch] cancel');
    });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /**
   * 把相机的世界矩阵/逆矩阵刷成当前位置。three.js 只在 renderer.render() 里
   * 更新这两个矩阵，而拾取和投影在「切机位后还没出一帧」时就会用到它们：
   * 若等不到下一帧，射线和投影都会按旧机位计算，点哪都点不中。
   */
  function syncCamera() {
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  }

  function pick(clientX, clientY) {
    var rect = renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    syncCamera();
    raycaster.setFromCamera(ndc, camera);

    var hits = raycaster.intersectObjects(pickable, false);
    if (DEBUG_PICK) {
      console.log('[diag:pick] at=(' + clientX.toFixed(0) + ',' + clientY.toFixed(0) + ')' +
        ' ndc=(' + ndc.x.toFixed(3) + ',' + ndc.y.toFixed(3) + ')' +
        ' pickable=' + pickable.length +
        ' hits=' + hits.length +
        (hits.length ? ' first=' + hits[0].object.userData.partKey : ''));
    }

    if (!hits.length) {
      clearSelection();
      try { bridge.onBackgroundTap(); } catch (e) {}
      needsRender = true;
      return;
    }

    var hit = hits[0];
    var key = hit.object.userData.partKey;
    // 优先用反向表（覆盖全部 77 个网格），回退到热点映射
    var partId = meshToPart[key];
    if (!partId) {
      var info0 = partInfoByMesh(key);
      partId = info0 ? info0.partId : null;
    }
    if (!partId) return;

    applyHighlight(hit.object);
    var info = {
      partId: partId,
      partName: nameOf(partId),
      parentName: parentNameOf(partId)
    };
    selected = {
      mesh: hit.object,
      node: key,
      partId: partId,
      name: info.partName,
      parentName: info.parentName,
      point: hit.point.clone()
    };
    showTag(info, docCounts[partId] || 0);

    try {
      bridge.onPartSelected(partId, info.partName, docCounts[partId] || 0);
    } catch (e) {}
    needsRender = true;
  }

  function partInfoByMesh(nodeName) {
    if (!map) return null;
    for (var v = 0; v < map.views.length; v++) {
      var hs = map.views[v].hotspots;
      for (var h = 0; h < hs.length; h++) {
        if (hs[h].meshes.indexOf(nodeName) !== -1) return hs[h];
      }
    }
    return null;
  }

  function applyHighlight(mesh) {
    clearHighlight();
    if (!mesh || !mesh.material) return;
    if (mesh.material.emissive) {
      mesh.material.emissive.setHex(HIGHLIGHT_EMISSIVE);
      mesh.material.emissiveIntensity = 0.62;
    }
  }

  function clearHighlight() {
    for (var key in meshRegistry) {
      var m = meshRegistry[key];
      if (m && m.material && m.material.emissive) {
        m.material.emissive.setHex(0x000000);
      }
    }
  }

  function clearSelection() {
    clearHighlight();
    selected = null;
    var tag = document.getElementById('tag');
    if (tag) tag.classList.remove('show');
    needsRender = true;
  }

  /* -------------------------------------------------- 浮动标签（跟随部件） */
  function showTag(info, count) {
    var tag = document.getElementById('tag');
    if (!tag) return;
    // 热点对象上的字段是 partName / parentName；selectPart 传入的也是同一结构。
    // 这里统一取一次，避免两处调用各写各的字段名。
    var title = info.partName || info.name || '';
    var parent = info.parentName || '';
    tag.innerHTML = title +
      (parent && parent !== title ? '<small>' + parent + '</small>' : '') +
      (count > 0 ? '<small>已有资料 ' + count + ' 条</small>' : '');
    tag.classList.add('show');
    updateTagPosition();
  }

  function updateTagPosition() {
    if (!selected) return;
    var tag = document.getElementById('tag');
    if (!tag) return;
    var p = selected.point.clone().project(camera);
    var rect = renderer.domElement.getBoundingClientRect();
    var x = (p.x * 0.5 + 0.5) * rect.width + rect.left;
    var y = (-p.y * 0.5 + 0.5) * rect.height + rect.top;
    tag.style.left = x + 'px';
    tag.style.top = y + 'px';
  }

  /* ------------------------------------------------------------ 主循环 */
  function loop() {
    requestAnimationFrame(loop);
    var moved = false;
    try { moved = controls.update(); } catch (e) {}
    var tweening = stepTween();          // 相机飞行中需持续出帧
    if (moved || tweening || needsRender) {
      renderer.render(scene, camera);
      needsRender = false;
      updateTagPosition();
    }
  }

  function onResize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, true);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // 屏幕比例变化较大、且用户还没手动调过视角时，重新框一次模型，
    // 否则横竖屏切换后模型可能被切掉。
    if (!userMoved && lastFitAspect > 0 && Math.abs(camera.aspect - lastFitAspect) / lastFitAspect > 0.12) {
      var cfg = VIEW_CAMERA[currentView] || VIEW_CAMERA.overview;
      moveCamera(cfg);
    }
    needsRender = true;
  }

  /* ------------------------------------------- 暴露给原生侧调用的接口 */
  window.setView = function (viewId) { setView(viewId); };

  window.selectPart = function (partId) {
    if (!map) return;
    var meshes = meshesOf(partId);
    if (!meshes.length) { clearSelection(); return; }

    var mesh = null;
    for (var j = 0; j < meshes.length; j++) {
      if (meshRegistry[meshes[j]]) { mesh = meshRegistry[meshes[j]]; break; }
    }
    if (!mesh) return;

    applyHighlight(mesh);

    // 用整组网格的包围盒中心作为浮标锚点，比单个网格更有代表性
    var box = new THREE.Box3();
    for (var i = 0; i < meshes.length; i++) {
      if (meshRegistry[meshes[i]]) box.expandByObject(meshRegistry[meshes[i]]);
    }
    var anchor = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());

    var info = {
      partId: partId,
      partName: nameOf(partId),
      parentName: parentNameOf(partId)
    };
    selected = {
      mesh: mesh, node: mesh.userData.partKey, partId: partId,
      name: info.partName, parentName: info.parentName, point: anchor
    };
    showTag(info, docCounts[partId] || 0);
    needsRender = true;
  };

  window.setDocCounts = function (json) {
    try {
      docCounts = typeof json === 'string' ? JSON.parse(json) : (json || {});
    } catch (e) { docCounts = {}; }
    needsRender = true;
  };

  function currentViewView() {
    for (var i = 0; i < map.views.length; i++) {
      if (map.views[i].id === currentView) return map.views[i];
    }
    return map.views[0];
  }

  window.setTheme = function (name) { applyTheme(name); };

  /* ------------------------------------------------ 相机飞行（列表定位） */
  // 目录树里点「定位」时镜头飞到该部件。
  // 这条路径解决细长部件在远景里点不准的问题：3D 点选管"顺手"，列表定位管"找得准"。
  var tween = null;

  function tweenCameraTo(target, dist) {
    var dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.7, 0.5, 0.7);
    dir.normalize();
    tween = {
      start: performance.now(),
      dur: 620,
      fromPos: camera.position.clone(),
      fromTgt: controls.target.clone(),
      toPos: target.clone().addScaledVector(dir, dist),
      toTgt: target.clone()
    };
    needsRender = true;
  }

  function stepTween() {
    if (!tween) return false;
    var k = Math.min(1, (performance.now() - tween.start) / tween.dur);
    var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // ease-in-out
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    controls.target.lerpVectors(tween.fromTgt, tween.toTgt, e);
    controls.update();
    if (k >= 1) tween = null;
    return true;
  }

  /** 找出包含指定部件 ID 的热点，优先在当前机位里找 */
  function findHotspot(partId, currentFirst) {
    var order = [];
    if (currentFirst) {
      for (var i = 0; i < map.views.length; i++) {
        if (map.views[i].id === currentView) { order.push(map.views[i]); break; }
      }
    }
    for (var j = 0; j < map.views.length; j++) {
      if (map.views[j].id !== currentView || !currentFirst) order.push(map.views[j]);
    }
    for (var k = 0; k < order.length; k++) {
      var hs = order[k].hotspots;
      for (var h = 0; h < hs.length; h++) {
        if (hs[h].partId === partId) {
          return { view: order[k], spot: hs[h], switched: order[k].id !== currentView };
        }
      }
    }
    return null;
  }

  /** 按部件 ID 取它的全部网格节点名（覆盖全部 53 个二级系统） */
  function meshesOf(partId) {
    if (map && map.partMeshes && map.partMeshes[partId]) return map.partMeshes[partId];
    // 回退：老的热点映射
    for (var v = 0; v < map.views.length; v++) {
      var hs = map.views[v].hotspots;
      for (var h = 0; h < hs.length; h++) {
        if (hs[h].partId === partId) return hs[h].meshes;
      }
    }
    return [];
  }

  function indexOf_(partId) {
    if (!map || !map.partIndex) return null;
    for (var i = 0; i < map.partIndex.length; i++) {
      if (map.partIndex[i].id === partId) return map.partIndex[i];
    }
    return null;
  }

  function nameOf(partId) {
    var it = indexOf_(partId);
    return it ? it.name : partId;
  }

  function parentNameOf(partId) {
    var it = indexOf_(partId);
    return it ? it.parentName : '';
  }

  /**
   * 结构外罩。定位到内部部件时要把这些设为半透明，
   * 否则镜头飞过去也只能看到一层壳。
   */
  var COVERS = ['nacelle_cover', 'spinner', 'hub',
                'tower_seg_1', 'tower_seg_2', 'tower_seg_3', 'tower_seg_4'];

  /** 定位到机舱/塔筒深处的细部时，这些大件也要一起透视 */
  var DEEP_OCCLUDERS = ['generator_stator', 'generator_rotor', 'base_frame',
                        'inner_platform', 'nacelle_cabinets', 'cable_tray'];

  function applyXray(targetMeshes) {
    var inTarget = {};
    for (var i = 0; i < targetMeshes.length; i++) inTarget[targetMeshes[i]] = true;

    // 目标很小时，说明是机舱内/塔筒内的细部，除了外罩还要把几件大件一起透视，
    // 否则镜头飞进去看到的还是发电机侧壁这类大曲面。
    var box = new THREE.Box3();
    for (var k = 0; k < targetMeshes.length; k++) {
      var tm = meshRegistry[targetMeshes[k]];
      if (tm) box.expandByObject(tm);
    }
    var small = !box.isEmpty() && box.getSize(new THREE.Vector3()).length() < 7;

    var fadeList = COVERS.concat(small ? DEEP_OCCLUDERS : []);

    for (var c = 0; c < fadeList.length; c++) {
      var name = fadeList[c];
      var m = meshRegistry[name];
      if (!m || !m.material) continue;
      // 目标本身就是这个部件时保持实心，否则透视
      var shouldFade = !inTarget[name];
      if (shouldFade) {
        m.material.transparent = true;
        m.material.opacity = FADE_OPACITY;
        m.material.depthWrite = false;
      } else {
        m.material.transparent = false;
        m.material.opacity = 1.0;
        m.material.depthWrite = true;
      }
      m.material.needsUpdate = true;
    }
  }

  /**
   * 镜头飞到指定部件并高亮。对全部 53 个二级系统都有效——
   * 这是「点一下视角就过去」的实现：从目录树、搜索结果、三维部件列表
   * 任意入口进来都能定位。
   */
  window.focusPart = function (partId) {
    if (!map) return;
    var meshes = meshesOf(partId);
    if (!meshes.length) { console.warn('focusPart: 部件无网格 ' + partId); return; }

    // 若该部件不在当前机位开放的拾取范围内，先切到包含它的机位
    var found = findHotspot(partId, true);
    if (found && found.switched) setView(found.view.id, false);

    var box = new THREE.Box3();
    var any = false;
    for (var i = 0; i < meshes.length; i++) {
      var m = meshRegistry[meshes[i]];
      if (m) { box.expandByObject(m); any = true; }
    }
    if (!any) { console.warn('focusPart: 网格未注册 ' + partId); return; }

    applyXray(meshes);

    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());

    /*
     * 取景距离按「包围盒最大边长」配合视场角算，而不是用包围球半径乘系数。
     * 后者对细长部件（塔筒段）会估得过大、对小部件（一个润滑泵）又估得过小，
     * 结果就是要么退太远、要么贴到脸上看不出它在机组的什么位置。
     */
    var maxDim = Math.max(size.x, size.y, size.z);
    var vFov = camera.fov * Math.PI / 180;
    var hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    var f = Math.min(vFov, hFov);
    var dist = (maxDim / 2) / Math.tan(f / 2) * 1.8;
    dist = Math.max(dist, 6);      // 小部件也要留出周围环境，才看得出位置

    tweenCameraTo(center, dist);

    window.selectPart(partId);
  };

  /**
   * 全部 53 个二级系统的定位自检：逐个检查网格是否注册、包围盒是否有效。
   * 只有这几项都成立，focusPart 才能把镜头飞过去。结果前缀 [audit:focus]。
   */
  window.__auditFocus = function () {
    if (!map || !map.partMeshes) { console.log('[audit:focus] 无 partMeshes'); return; }
    var ids = Object.keys(map.partMeshes);
    var okList = [], notRegistered = [], emptyBox = [];
    for (var i = 0; i < ids.length; i++) {
      var pid = ids[i];
      var meshes = map.partMeshes[pid];
      var box = new THREE.Box3();
      var found = 0;
      for (var j = 0; j < meshes.length; j++) {
        var m = meshRegistry[meshes[j]];
        if (m) { box.expandByObject(m); found++; }
      }
      if (found === 0) { notRegistered.push(pid); continue; }
      if (box.isEmpty()) { emptyBox.push(pid); continue; }
      var s = box.getSize(new THREE.Vector3());
      okList.push(pid + '(' + s.x.toFixed(1) + '×' + s.y.toFixed(1) + '×' + s.z.toFixed(1) + ')');
    }
    console.log('[audit:focus] 共 ' + ids.length + ' 个部件，可取景 ' + okList.length + ' 个' +
      (notRegistered.length ? ' | 网格未注册: ' + notRegistered.join(',') : '') +
      (emptyBox.length ? ' | 包围盒为空: ' + emptyBox.join(',') : ''));
    console.log('[audit:focus:detail] ' + okList.join(' '));
  };

  window.resetCamera = function () {
    setView(currentView, false);
  };

  /**
   * 相机与投影自检：打当前相机参数，并把若干已知世界点投影到 NDC。
   * 排查「模型在屏幕上却点不中 / 自检误报在视野外」时，用它区分是相机没到位、
   * 投影矩阵异常，还是射线被别的部件挡住。用法：__camState([[0,97,0],[0,140,0]])
   */
  window.__camState = function (extraPoints) {
    syncCamera();
    var pts = (extraPoints || []).map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
    var out = {
      view: currentView,
      pos: [camera.position.x, camera.position.y, camera.position.z].map(function (v) { return +v.toFixed(2); }),
      target: [controls.target.x, controls.target.y, controls.target.z].map(function (v) { return +v.toFixed(2); }),
      dist: +camera.position.distanceTo(controls.target).toFixed(2),
      fov: camera.fov,
      aspect: +camera.aspect.toFixed(4),
      near: +camera.near.toFixed(3),
      far: +camera.far.toFixed(1),
      pickable: pickable.length,
      project: []
    };
    for (var i = 0; i < pts.length; i++) {
      var ndc = pts[i].clone().project(camera);
      out.project.push({
        world: [pts[i].x, pts[i].y, pts[i].z],
        ndc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3), +ndc.z.toFixed(3)]
      });
    }
    console.log('[cam] ' + JSON.stringify(out));
    return out;
  };

  /**
   * 热点可达性自检：把每个热点的中心投影到屏幕，再从该屏幕点反向射线，
   * 看是否命中所属部件。用于验证「点得中」——盲点屏幕很容易漏掉细长目标。
   * 结果以 [audit:<机位>] 前缀输出到控制台。
   */
  window.__audit = function () {
    if (!map || !pickable.length) return;
    syncCamera();
    var view = currentViewView();
    var lines = [];
    for (var h = 0; h < view.hotspots.length; h++) {
      var hs = view.hotspots[h];
      var total = 0, ok = 0, offscreen = 0, missed = 0, missDetail = [];
      // 采样点取网格表面的三角形重心（等间隔抽），而不是包围盒角点：
      // 管件、法兰这类中空部件的包围盒中心落在实体内部，而 three.js 的射线
      // 只认正面（背面被剔除），从内部打出去必然打空，会误判成「点不中」。
      // 表面重心一定在表面上，能不能点中就等于「这一小片外表面有没有被挡住」。
      var SAMPLES_PER_MESH = 150;
      for (var j = 0; j < hs.meshes.length; j++) {
        var m = meshRegistry[hs.meshes[j]];
        if (!m || !m.geometry) continue;
        total++;
        var box = new THREE.Box3().setFromObject(m);
        if (box.isEmpty()) { missed++; continue; }

        var pos = m.geometry.attributes.position;
        var idx = m.geometry.index;
        var triCount = idx ? idx.count / 3 : pos.count / 3;
        if (!triCount) { missed++; continue; }
        var stride = Math.max(1, Math.floor(triCount / SAMPLES_PER_MESH));
        var samples = [];
        var va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
        for (var t0 = 0; t0 < triCount; t0 += stride) {
          if (idx) {
            va.fromBufferAttribute(pos, idx.getX(t0 * 3));
            vb.fromBufferAttribute(pos, idx.getX(t0 * 3 + 1));
            vc.fromBufferAttribute(pos, idx.getX(t0 * 3 + 2));
          } else {
            va.fromBufferAttribute(pos, t0 * 3);
            vb.fromBufferAttribute(pos, t0 * 3 + 1);
            vc.fromBufferAttribute(pos, t0 * 3 + 2);
          }
          va.add(vb).add(vc).multiplyScalar(1 / 3);
          m.localToWorld(va);                 // 顶点是局部坐标，必须转世界
          samples.push(va.clone());
        }

        var hit = false, anyInView = false, blocker = '';
        for (var s = 0; s < samples.length; s++) {
          var ndc = samples[s].clone().project(camera);
          if (ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1) continue;
          anyInView = true;
          raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
          var hits = raycaster.intersectObjects(pickable, false);
          if (hits.length && hits[0].object.userData.partKey === hs.meshes[j]) { hit = true; break; }
          // 记下是谁挡在前面：同部件的网格互相遮挡无害，别的部件才是真问题
          if (!blocker && hits.length) blocker = hits[0].object.userData.partKey;
        }
        if (hit) ok++;
        else if (!anyInView) offscreen++;
        else {
          missed++;
          if (blocker && hs.meshes.indexOf(blocker) < 0) missDetail.push(hs.meshes[j] + '←' + blocker);
        }
      }
      var verdict = ok > 0 ? '✓' : (offscreen === total ? '在视野外' : '被挡');
      lines.push(hs.id + ' ' + hs.label + ' ' + ok + '/' + total + ' ' + verdict +
        (missDetail.length ? '(' + missDetail.join(',') + ')' : ''));
    }
    console.log('[audit:' + view.id + '] ' + lines.join(' | '));
  };

  /* ------------------------------------------------------------ 启动 */
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 0);
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
