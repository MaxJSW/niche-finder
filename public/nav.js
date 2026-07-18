// niche-finder/public/nav.js
// Sidebar commune injectée dans <aside class="side"> de chaque page.
// L'onglet actif est déduit de l'URL — rien à configurer par page.

const LINKS = [
  { href: '/',             label: '🔍 Recherche' },
  { href: '/pins.html',    label: '📌 Épinglés' },
  { href: '/targets.html', label: '🎯 Channel Crawl' },
  { href: '/queries.html', label: '🔬 Analyse titres' },
  { href: '#',             label: '🕑 Historique' },
];

const FOOT_LINKS = [
  { href: '#', label: '⚙️ Réglages' },
];

function currentPath() {
  const p = location.pathname;
  return (p === '' || p === '/index.html') ? '/' : p;
}

function renderLinks(links) {
  const here = currentPath();
  return links.map(l => {
    const active = l.href !== '#' && l.href === here ? ' class="active"' : '';
    return `<a href="${l.href}"${active}>${l.label}</a>`;
  }).join('');
}

function mountSidebar() {
  const side = document.querySelector('aside.side');
  if (!side) return;
  side.innerHTML = `
    <div class="logo">
      <span class="logo-dot"></span>
      <span class="logo-txt">Niche Finder<small>Veille YouTube</small></span>
    </div>
    <nav class="nav">${renderLinks(LINKS)}</nav>
    <div class="side-foot">
      <nav class="nav">${renderLinks(FOOT_LINKS)}</nav>
    </div>`;
}

mountSidebar();