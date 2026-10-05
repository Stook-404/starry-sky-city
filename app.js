const spaceCanvas = document.querySelector('#space-canvas');
const spaceCtx = spaceCanvas?.getContext('2d');
let stars = [];

function resizeSpace() {
  if (!spaceCanvas || !spaceCtx) return;
  spaceCanvas.width = window.innerWidth * devicePixelRatio;
  spaceCanvas.height = window.innerHeight * devicePixelRatio;
  spaceCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  stars = Array.from({ length: Math.min(170, Math.floor(window.innerWidth / 7)) }, () => ({
    x: Math.random() * innerWidth,
    y: Math.random() * innerHeight,
    r: Math.random() * 1.1 + .1,
    a: Math.random() * .4 + .16,
    s: Math.random() * .12 + .02,
    p: Math.random() * Math.PI * 2,
  }));
}

function drawSpace(t = 0) {
  if (!spaceCtx) return;
  const w = innerWidth;
  const h = innerHeight;
  spaceCtx.clearRect(0, 0, w, h);
  for (const star of stars) {
    const alpha = star.a * (.7 + .3 * Math.sin(t * .001 * star.s * 20 + star.p));
    spaceCtx.fillStyle = `rgba(190, 229, 255, ${alpha})`;
    spaceCtx.beginPath();
    spaceCtx.arc(star.x, (star.y + t * star.s * .012) % h, star.r, 0, Math.PI * 2);
    spaceCtx.fill();
  }
  requestAnimationFrame(drawSpace);
}

resizeSpace();
drawSpace();
window.addEventListener('resize', resizeSpace);

const modal = document.querySelector('#login-modal');
const loginTrigger = document.querySelector('#login-trigger');
const heroGenerate = document.querySelector('#hero-generate');
const modalClose = document.querySelector('#modal-close');
const modalSubmit = document.querySelector('#modal-submit');
const nameInput = document.querySelector('#display-name');
const generateButton = document.querySelector('#generate-button');
const saveButton = document.querySelector('#save-button');
const loginHint = document.querySelector('#login-hint');
const statusEl = document.querySelector('#generation-status');
const toast = document.querySelector('#toast');
const modelGrid = document.querySelector('#models-grid');
const modelCount = document.querySelector('#model-count');

let user = localStorage.getItem('astra-user') || '';
let currentCity = null;
let scene;
let renderer;
let camera;
let controls;
let cityGroup;
let keyLight;
const diameterInput = document.querySelector('#city-diameter');
diameterInput.addEventListener('input', () => {
  const km = Number(diameterInput.value);
  document.querySelector('#diameter-output').textContent = `${km} km`;
  document.querySelector('#diameter-hint').textContent = km > 5 ? '未来都会 · 湖泊、工业园与发电站' : '紧凑城心 · 河流与街区公园';
});
for (const [id, phi, zoom] of [['view-reset', .60, 1], ['view-top', 1.43, 1], ['view-close', .44, .64]]) {
  document.querySelector('#' + id).addEventListener('click', () => {
    if (!controls || !currentCity) return;
    controls.theta = .78; controls.phi = phi; controls.radius = controls.overviewRadius * zoom;
    controls.target.set(0, .65, 0);
  });
}

function showModal() {
  modal.hidden = false;
  nameInput.focus();
}

function hideModal() {
  modal.hidden = true;
}

function updateLogin() {
  if (user) {
    loginTrigger.innerHTML = `${user} <span>↗</span>`;
    loginHint.textContent = '保存会写入当前设备的模型档案';
  } else {
    loginTrigger.innerHTML = '登录 <span>↗</span>';
    loginHint.textContent = '登录后即可保存你生成的城市';
  }
}

loginTrigger.addEventListener('click', () => (user ? toastMessage(`已登录：${user}`) : showModal()));
heroGenerate.addEventListener('click', () => {
  if (user) document.querySelector('.generator-panel').scrollIntoView({ behavior: 'smooth' });
  else showModal();
});
modalClose.addEventListener('click', hideModal);
modal.addEventListener('click', (event) => {
  if (event.target === modal) hideModal();
});
modalSubmit.addEventListener('click', () => {
  const value = nameInput.value.trim() || '星际建筑师';
  user = value;
  localStorage.setItem('astra-user', user);
  hideModal();
  updateLogin();
  toastMessage(`欢迎，${user}。现在可以生成城市了。`);
  document.querySelector('.generator-panel').scrollIntoView({ behavior: 'smooth' });
});
nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') modalSubmit.click();
});

function toastMessage(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function initScene() {
  const host = document.querySelector('#city-scene');
  if (typeof THREE === 'undefined') {
    throw new Error('3D 运行库加载失败，请刷新页面重试。');
  }
  if (scene) return;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#040a12');
  scene.fog = new THREE.FogExp2('#102131', .018);
  camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, .1, 200);
  camera.position.set(7, 7, 8);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (THREE.ACESFilmicToneMapping) renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.28;
  host.innerHTML = '';
  host.appendChild(renderer.domElement);
  controls = new SimpleOrbit(camera, renderer.domElement);

  scene.add(new THREE.HemisphereLight('#c4dfed', '#35434b', 2.6));
  const key = new THREE.DirectionalLight('#e7f7ff', 3.1);
  keyLight = key;
  key.position.set(5, 10, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: .5, far: 30 });
  key.shadow.normalBias = .004;
  key.shadow.bias = -.0001;
  scene.add(key);
  const fill = new THREE.DirectionalLight('#8dbacc', 1.8);
  fill.position.set(-6, 5, -4);
  scene.add(fill);
  const rim = new THREE.PointLight('#39d8ff', 3.4, 15);
  rim.position.set(-4, 4, 2);
  scene.add(rim);
  const violet = new THREE.PointLight('#8d7cff', 2.2, 13);
  violet.position.set(4, 2, -4);
  scene.add(violet);

  window.addEventListener('resize', () => {
    if (!renderer || !camera) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  });
  renderScene();
}

class SimpleOrbit {
  constructor(cam, dom) {
    this.camera = cam;
    this.dom = dom;
    this.theta = .78;
    this.phi = .60;
    this.radius = 11.7;
    this.target = new THREE.Vector3(0, .65, 0);
    this.pan = false;
    this.drag = false;
    this.last = [0, 0];
    dom.addEventListener('pointerdown', (event) => {
      this.drag = true;
      this.pan = event.shiftKey || event.button === 2;
      this.last = [event.clientX, event.clientY];
      dom.setPointerCapture(event.pointerId);
    });
    dom.addEventListener('pointermove', (event) => {
      if (!this.drag) return;
      const dx = event.clientX - this.last[0], dy = event.clientY - this.last[1];
      if (this.pan) {
        const factor = this.radius / Math.max(300, dom.clientHeight) * .65;
        this.target.x -= (dx * Math.cos(this.theta) + dy * Math.sin(this.theta)) * factor;
        this.target.z += (dx * Math.sin(this.theta) - dy * Math.cos(this.theta)) * factor;
        const limit = currentCity?.half || 3;
        this.target.x = Math.max(-limit, Math.min(limit, this.target.x));
        this.target.z = Math.max(-limit, Math.min(limit, this.target.z));
      } else {
        this.theta -= dx * .009;
        this.phi = Math.max(.28, Math.min(1.5, this.phi + dy * .006));
      }
      this.last = [event.clientX, event.clientY];
    });
    dom.addEventListener('pointerup', () => (this.drag = false));
    dom.addEventListener('pointercancel', () => (this.drag = false));
    dom.addEventListener('contextmenu', event => event.preventDefault());
    dom.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.radius = Math.max(4.2, Math.min(this.overviewRadius * 1.7 || 24, this.radius + event.deltaY * .008 * (this.scale || 1)));
    }, { passive: false });
    this.update();
  }

  update() {
    const x = Math.sin(this.theta) * Math.cos(this.phi) * this.radius;
    const z = Math.cos(this.theta) * Math.cos(this.phi) * this.radius;
    const y = Math.sin(this.phi) * this.radius;
    this.camera.position.set(x + this.target.x, y, z + this.target.z);
    this.camera.lookAt(this.target);
  }
}

function generateCityLayout(seed) {
  return window.CityModel.generate(seed, Number(document.querySelector('#city-diameter').value));
}

function applyCityStats(layout) {
  document.querySelector('#city-size').textContent = `${layout.diameter} KM`;
  document.querySelector('#building-count').textContent = layout.buildings;
  document.querySelector('#bridge-count').textContent = String(layout.bridges).padStart(2, '0');
  document.querySelector('#boundary-type').textContent = layout.boundary;
  document.querySelector('#scene-seed').textContent = `SEED ${String(layout.seed).padStart(6, '0')}`;
  document.querySelector('#ecology-stats').textContent = `公园 ${layout.parkData.length} · 湖泊 ${layout.lakeData.length} · 工厂 ${layout.facilityData.filter(s => s.type === 'factory').length} · 发电站 ${layout.facilityData.filter(s => s.type === 'power').length}`;
  statusEl.textContent = '城市已生成 · 水域与地块已避让';
  saveButton.disabled = !user;
}

let generating = false;
function disposeCity(group) {
  if (!group) return;
  const resources = new Set();
  group.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    if (object.material) {
      resources.add(object.material);
      for (const value of Object.values(object.material)) if (value?.isTexture) resources.add(value);
    }
  });
  resources.forEach(resource => resource.dispose());
}

async function makeCity() {
  if (generating) return;
  try { initScene(); } catch (error) {
    statusEl.textContent = '3D 渲染暂不可用';
    toastMessage('无法启动 3D 渲染，请开启浏览器硬件加速后刷新页面。');
    console.error(error);
    return;
  }
  generating = true;
  generateButton.disabled = true;
  saveButton.disabled = true;
  statusEl.textContent = '正在规划水系、街区与建筑…';
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  try {
  const layout = generateCityLayout(Math.floor(Math.random() * 999999));
  const next = window.CityModel.build(layout);
  if (cityGroup) scene.remove(cityGroup);
  disposeCity(cityGroup);
  cityGroup = next;
  scene.add(cityGroup);
  currentCity = layout;
  controls.scale = layout.diameter / 3;
  controls.overviewRadius = (layout.half + .7) * 3.0 * Math.max(1, .9 / camera.aspect);
  controls.radius = controls.overviewRadius;
  controls.phi = .60;
  controls.target.set(0, .65, 0);
  keyLight.position.set(layout.half * 1.5, layout.half * 3.5, layout.half);
  Object.assign(keyLight.shadow.camera, {left: -layout.half * 1.6, right: layout.half * 1.6, top: layout.half * 1.6, bottom: -layout.half * 1.6, far: layout.half * 10});
  keyLight.shadow.camera.updateProjectionMatrix();
  scene.fog.density = .018 / Math.sqrt(controls.scale);
  applyCityStats(layout);
  toastMessage(`${layout.diameter} km 未来城市已生成，包含 ${layout.parkData.length} 座公园${layout.lakeData.length ? '与 ' + layout.lakeData.length + ' 片湖泊' : ''}。`);
  } catch (error) {
    statusEl.textContent = '本次生成未完成，请重试';
    toastMessage('城市生成未完成，请重试或选择较小直径。');
    console.error(error);
  } finally {
    generating = false;
    generateButton.disabled = false;
    saveButton.disabled = !currentCity || !user;
  }
}

function renderScene() {
  if (renderer && scene) {
    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(renderScene);
}

generateButton.addEventListener('click', () => {
  if (!user) {
    showModal();
    return;
  }
  makeCity();
});

saveButton.addEventListener('click', () => {
  if (!currentCity || !user) return;
  const saved = JSON.parse(localStorage.getItem('astra-models') || '[]');
  saved.unshift({ ...currentCity, name: `${user} 的城市 ${saved.length + 1}`, date: new Date().toLocaleDateString('zh-CN') });
  localStorage.setItem('astra-models', JSON.stringify(saved.slice(0, 9)));
  renderModels();
  toastMessage('已保存到“我的城市模型”。');
});

function renderModels() {
  const models = JSON.parse(localStorage.getItem('astra-models') || '[]');
  modelCount.textContent = `${models.length} 个已保存`;
  if (!models.length) {
    modelGrid.innerHTML = '<div class="empty-model"><span>✦</span><p>你的城市档案会出现在这里</p><small>生成并保存一座城市，建立你的星穹版图</small></div>';
    return;
  }
  modelGrid.innerHTML = models.map((model) => `<article class="model-card"><div class="model-preview"></div><time>${model.date}</time><h3>${model.name}</h3><p>${model.diameter || 3} KM · ${model.buildings} 建筑 · ${model.boundary} 边界</p></article>`).join('');
}

updateLogin();
renderModels();
const navLinks = [...document.querySelectorAll('.top-nav a')];
const sections = [...document.querySelectorAll('main section[id]')];
const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
  if (entry.isIntersecting) navLinks.forEach((link) => link.classList.toggle('is-active', link.dataset.nav === entry.target.id));
}), { rootMargin: '-35% 0px -55% 0px' });
sections.forEach((section) => observer.observe(section));
