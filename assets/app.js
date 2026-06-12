const DATA_URL = 'data/routes.json';
const ACCESS_KEY = 'routes_full_access_v1';

const state = {
  data: null,
  map: null,
  markers: new Map(),
  routeLine: null,
  selectedRouteId: null,
  activeCategories: new Set(),
  fullAccess: localStorage.getItem(ACCESS_KEY) === 'yes'
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  cityLabel: $('#cityLabel'),
  accessButton: $('#accessButton'),
  accessState: $('#accessState'),
  routesGrid: $('#routesGrid'),
  filters: $('#filters'),
  map: $('#map'),
  sheet: $('#sheet'),
  sheetContent: $('#sheetContent'),
  accessModal: $('#accessModal'),
  accessForm: $('#accessForm'),
  accessCode: $('#accessCode'),
  accessMessage: $('#accessMessage'),
  freeRouteButton: $('#freeRouteButton'),
  demoUnlockButton: $('#demoUnlockButton'),
  locateButton: $('#locateButton')
};

boot();

async function boot() {
  bindBaseEvents();
  try {
    state.data = await loadData();
    state.activeCategories = new Set(state.data.categories.map(category => category.id));
    renderMeta();
    renderRoutes();
    renderFilters();
    initMap();
    selectInitialRoute();
  } catch (error) {
    console.error(error);
    els.routesGrid.innerHTML = `
      <article class="route-card">
        <h3>Не удалось загрузить маршруты</h3>
        <p>Проверьте файл <code>data/routes.json</code> и откройте сайт через локальный сервер или хостинг.</p>
      </article>`;
    els.map.textContent = 'Карта недоступна без данных маршрутов.';
  }
}

async function loadData() {
  const response = await fetch(DATA_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Ошибка загрузки ${DATA_URL}`);
  const data = await response.json();
  validateData(data);
  return data;
}

function validateData(data) {
  const required = ['meta', 'categories', 'points', 'routes'];
  for (const key of required) {
    if (!data[key]) throw new Error(`В routes.json нет поля ${key}`);
  }
}

function bindBaseEvents() {
  $$('[data-scroll-to]').forEach(button => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.scrollTo);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  els.accessButton.addEventListener('click', openAccessModal);
  els.freeRouteButton.addEventListener('click', () => {
    const freeRoute = state.data?.routes.find(route => route.isFree);
    if (freeRoute) openRoute(freeRoute.id);
  });

  $$('[data-close-sheet]').forEach(node => node.addEventListener('click', closeSheet));
  $$('[data-close-access]').forEach(node => node.addEventListener('click', closeAccessModal));

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeSheet();
      closeAccessModal();
    }
  });

  els.accessForm.addEventListener('submit', event => {
    event.preventDefault();
    tryUnlock(els.accessCode.value);
  });

  els.demoUnlockButton.addEventListener('click', () => {
    setFullAccess(true);
    setAccessMessage('Демо-доступ открыт. На реальном сайте эту кнопку можно удалить.', 'ok');
    setTimeout(closeAccessModal, 600);
  });

  els.locateButton.addEventListener('click', locateUser);
}

function renderMeta() {
  els.cityLabel.textContent = state.data.meta.city || 'Велопрокат у моря';
  els.accessState.textContent = state.fullAccess ? 'Полный доступ открыт' : '1 маршрут бесплатно';
  els.accessButton.textContent = state.fullAccess ? 'Доступ ✓' : 'Код';
}

function renderRoutes() {
  els.routesGrid.innerHTML = state.data.routes.map(route => {
    const locked = isRouteLocked(route);
    return `
      <button class="route-card ${locked ? 'locked' : ''} ${route.comingSoon ? 'coming' : ''}" type="button" data-route-id="${route.id}">
        <div class="route-meta-row">
          <span class="tag ${route.isFree ? '' : 'gold'}">${route.type}</span>
          <span class="tag">${route.bestFor || 'Маршрут'}</span>
        </div>
        <h3>${escapeHtml(route.title)}</h3>
        <p>${escapeHtml(route.description)}</p>
        <div class="metric-row">
          <span class="metric"><small>Время</small><strong>${escapeHtml(route.time)}</strong></span>
          <span class="metric"><small>Дистанция</small><strong>${escapeHtml(route.distance)}</strong></span>
          <span class="metric"><small>Сложность</small><strong>${escapeHtml(route.difficulty)}</strong></span>
        </div>
      </button>`;
  }).join('');

  $$('.route-card', els.routesGrid).forEach(card => {
    card.addEventListener('click', () => openRoute(card.dataset.routeId));
  });
}

function renderFilters() {
  els.filters.innerHTML = state.data.categories.map(category => `
    <button class="filter-chip active" type="button" data-category-id="${category.id}">
      ${category.icon} ${category.label}
    </button>`).join('');

  $$('.filter-chip', els.filters).forEach(chip => {
    chip.addEventListener('click', () => {
      const categoryId = chip.dataset.categoryId;
      if (state.activeCategories.has(categoryId)) {
        state.activeCategories.delete(categoryId);
        chip.classList.remove('active');
      } else {
        state.activeCategories.add(categoryId);
        chip.classList.add('active');
      }
      renderMarkers();
    });
  });
}

function initMap() {
  if (!window.L) {
    els.map.textContent = 'Не удалось загрузить карту. Проверьте интернет-соединение.';
    return;
  }

  const start = state.data.meta.rental;
  state.map = L.map('map', {
    zoomControl: false,
    tap: true,
    scrollWheelZoom: false
  }).setView([start.lat, start.lng], 14);

  L.control.zoom({ position: 'bottomright' }).addTo(state.map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(state.map);

  renderMarkers();
}

function renderMarkers() {
  if (!state.map) return;

  for (const marker of state.markers.values()) marker.remove();
  state.markers.clear();

  const visiblePoints = state.data.points.filter(point => state.activeCategories.has(point.category));
  for (const point of visiblePoints) {
    const category = getCategory(point.category);
    const marker = L.marker([point.lat, point.lng], { icon: makeIcon(category) })
      .addTo(state.map)
      .on('click', () => openPoint(point.id));
    state.markers.set(point.id, marker);
  }

  drawSelectedRoute();
}

function makeIcon(category) {
  return L.divIcon({
    className: '',
    html: `<div class="custom-marker" style="background:${category?.color || '#2f5d50'}">${category?.icon || '•'}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

function selectInitialRoute() {
  const freeRoute = state.data.routes.find(route => route.isFree && !route.comingSoon);
  if (freeRoute) selectRouteOnMap(freeRoute.id, false);
}

function openRoute(routeId) {
  const route = getRoute(routeId);
  if (!route) return;

  if (route.comingSoon) {
    openSheet(renderComingSoon(route));
    return;
  }

  if (isRouteLocked(route)) {
    openAccessModal(route.title);
    return;
  }

  selectRouteOnMap(route.id, true);
  openSheet(renderRouteSheet(route));
}

function selectRouteOnMap(routeId, moveMap) {
  state.selectedRouteId = routeId;
  drawSelectedRoute();
  if (!state.map) return;

  const route = getRoute(routeId);
  const coords = getRoutePoints(route).map(point => [point.lat, point.lng]);
  if (coords.length && moveMap) state.map.fitBounds(coords, { padding: [28, 28], maxZoom: 15 });
}

function drawSelectedRoute() {
  if (!state.map) return;
  if (state.routeLine) state.routeLine.remove();

  const route = getRoute(state.selectedRouteId);
  if (!route || !route.points?.length) return;

  const coords = getRoutePoints(route).map(point => [point.lat, point.lng]);
  if (coords.length < 2) return;

  state.routeLine = L.polyline(coords, {
    color: '#2f5d50',
    weight: 5,
    opacity: 0.78,
    lineCap: 'round',
    lineJoin: 'round'
  }).addTo(state.map);
}

function renderRouteSheet(route) {
  const points = getRoutePoints(route);
  const yandexRouteUrl = buildYandexRouteUrl(points);
  return `
    <span class="tag ${route.isFree ? '' : 'gold'}">${route.type}</span>
    <h2 class="sheet-title" id="sheetTitle">${escapeHtml(route.title)}</h2>
    <p class="sheet-subtitle">${escapeHtml(route.description)}</p>
    <div class="info-grid">
      <span class="metric"><small>Время</small><strong>${escapeHtml(route.time)}</strong></span>
      <span class="metric"><small>Дистанция</small><strong>${escapeHtml(route.distance)}</strong></span>
      <span class="metric"><small>Сложность</small><strong>${escapeHtml(route.difficulty)}</strong></span>
    </div>
    ${renderBullets('Что внутри', route.summary)}
    ${renderBullets('Важно', route.warnings)}
    <h3>Точки маршрута</h3>
    <div class="point-list">
      ${points.map(point => `
        <button class="point-button" type="button" data-point-id="${point.id}">
          <span>${getCategory(point.category)?.icon || '•'} ${escapeHtml(point.title)}</span>
          <span>›</span>
        </button>`).join('')}
    </div>
    <div class="action-stack">
      <a class="primary-button" href="${yandexRouteUrl}" target="_blank" rel="noopener">Открыть маршрут в Яндекс.Картах</a>
      <button class="secondary-button" type="button" data-scroll-map>Показать на карте сервиса</button>
    </div>`;
}

function renderComingSoon(route) {
  return `
    <span class="tag gold">Скоро</span>
    <h2 class="sheet-title" id="sheetTitle">${escapeHtml(route.title)}</h2>
    <p class="sheet-subtitle">${escapeHtml(route.description)}</p>
    <div class="detail-list">
      <article><strong>Как добавить</strong><span>Создайте точки в <code>data/routes.json</code>, затем добавьте их ID в массив <code>points</code> этого маршрута.</span></article>
    </div>`;
}

function openPoint(pointId) {
  const point = getPoint(pointId);
  if (!point) return;

  const category = getCategory(point.category);
  openSheet(`
    <span class="tag" style="background:${category?.color || '#2f5d50'}18;color:${category?.color || '#2f5d50'}">${category?.icon || '•'} ${category?.label || 'Точка'}</span>
    <h2 class="sheet-title" id="sheetTitle">${escapeHtml(point.title)}</h2>
    <p class="sheet-subtitle">${escapeHtml(point.description)}</p>
    <div class="info-grid">
      <span class="metric"><small>От проката</small><strong>${escapeHtml(point.fromRental || '—')}</strong></span>
      <span class="metric"><small>Широта</small><strong>${point.lat.toFixed(5)}</strong></span>
      <span class="metric"><small>Долгота</small><strong>${point.lng.toFixed(5)}</strong></span>
    </div>
    <div class="detail-list">
      ${detail('Локальный совет', point.advice)}
      ${detail('Где оставить велосипед', point.bikeParking)}
      ${detail('Где туалет', point.toilet)}
      ${detail('Где перекусить', point.food)}
      ${detail('Предупреждения', point.warnings)}
    </div>
    <div class="action-stack">
      <a class="primary-button" href="${buildYandexPointUrl(point)}" target="_blank" rel="noopener">Открыть в Яндекс.Картах</a>
      <a class="secondary-button" href="${buildYandexRouteUrl([state.data.meta.rental, point])}" target="_blank" rel="noopener">Построить путь от проката</a>
    </div>`);

  if (state.map) {
    state.map.setView([point.lat, point.lng], Math.max(state.map.getZoom(), 15), { animate: true });
  }
}

function openSheet(html) {
  els.sheetContent.innerHTML = html;
  els.sheet.classList.add('open');
  els.sheet.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  $$('.point-button', els.sheetContent).forEach(button => {
    button.addEventListener('click', () => openPoint(button.dataset.pointId));
  });

  $('[data-scroll-map]', els.sheetContent)?.addEventListener('click', () => {
    closeSheet();
    $('#mapSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function closeSheet() {
  els.sheet.classList.remove('open');
  els.sheet.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function openAccessModal(routeTitle = '') {
  els.accessModal.classList.add('open');
  els.accessModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  els.accessCode.value = '';
  setAccessMessage(routeTitle ? `Маршрут «${routeTitle}» доступен после кода.` : '', '');
  setTimeout(() => els.accessCode.focus(), 80);
}

function closeAccessModal() {
  els.accessModal.classList.remove('open');
  els.accessModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function tryUnlock(rawCode) {
  const code = normalizeCode(rawCode);
  const validCodes = (state.data?.meta.unlockCodes || []).map(normalizeCode);
  if (validCodes.includes(code)) {
    setFullAccess(true);
    setAccessMessage('Готово. Полный доступ открыт на этом телефоне.', 'ok');
    setTimeout(closeAccessModal, 650);
  } else {
    setAccessMessage('Код не подошёл. Проверьте раскладку и пробелы.', 'bad');
  }
}

function setFullAccess(value) {
  state.fullAccess = value;
  localStorage.setItem(ACCESS_KEY, value ? 'yes' : 'no');
  renderMeta();
  renderRoutes();
}

function setAccessMessage(text, type) {
  els.accessMessage.textContent = text;
  els.accessMessage.className = `form-message ${type || ''}`;
}

function locateUser() {
  if (!navigator.geolocation || !state.map) {
    alert('Геолокация недоступна в этом браузере.');
    return;
  }
  els.locateButton.textContent = 'Ищу…';
  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords;
      L.circleMarker([latitude, longitude], {
        radius: 8,
        color: '#2f5d50',
        fillColor: '#2f5d50',
        fillOpacity: .25
      }).addTo(state.map).bindPopup('Вы здесь').openPopup();
      state.map.setView([latitude, longitude], 15);
      els.locateButton.textContent = 'Я рядом';
    },
    () => {
      alert('Не удалось получить геолокацию. Разрешите доступ в настройках браузера.');
      els.locateButton.textContent = 'Я рядом';
    },
    { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 }
  );
}

function isRouteLocked(route) {
  return !route.isFree && !state.fullAccess && !route.comingSoon;
}

function getPoint(id) {
  return state.data.points.find(point => point.id === id);
}

function getRoute(id) {
  return state.data.routes.find(route => route.id === id);
}

function getCategory(id) {
  return state.data.categories.find(category => category.id === id);
}

function getRoutePoints(route) {
  const points = route.points || [];
  return points.map(getPoint).filter(Boolean);
}

function detail(label, value) {
  if (!value) return '';
  return `<article><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></article>`;
}

function renderBullets(title, items = []) {
  if (!items.length) return '';
  return `<div class="detail-list"><article><strong>${escapeHtml(title)}</strong><span>${items.map(item => `• ${escapeHtml(item)}`).join('<br>')}</span></article></div>`;
}

function buildYandexPointUrl(point) {
  const ll = `${point.lng},${point.lat}`;
  const text = encodeURIComponent(point.title || 'Точка маршрута');
  return `https://yandex.ru/maps/?ll=${ll}&z=16&pt=${ll},pm2rdm&text=${text}`;
}

function buildYandexRouteUrl(points) {
  const cleanPoints = points.filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (cleanPoints.length < 2) return cleanPoints[0] ? buildYandexPointUrl(cleanPoints[0]) : 'https://yandex.ru/maps/';
  const rtext = cleanPoints.map(point => `${point.lat},${point.lng}`).join('~');
  // rtt=bc обычно открывает велосипедный режим в Яндекс.Картах. Если у пользователя не сработает, Яндекс всё равно покажет маршрут и позволит выбрать велосипед вручную.
  return `https://yandex.ru/maps/?rtext=${encodeURIComponent(rtext)}&rtt=bc`;
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}
