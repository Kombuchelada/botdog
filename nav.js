// Shared site header. Used by both dashboard.js and game.js so the nav can't
// drift between the two surfaces.
//
// Mobile behaviour matters here: the desktop nav used to overflow the viewport
// on phones, which made the whole page scroll horizontally and dragged the
// `sticky` header out of view sideways. Below `md` the links collapse into a
// toggle panel and the brand is pinned `whitespace-nowrap` so "Hot Dog Hub"
// never wraps to two lines.
//
// The background is deliberately OPAQUE. A translucent `bg-slate-950/80
// backdrop-blur` header forces the browser to re-rasterise a backdrop-filter
// layer whenever anything animates underneath it — and the game page animates
// a scaling glizzy on every click. On Safari that makes the header's emoji
// visibly shimmer/pulse in time with the clicking. Solid slate-950 over a
// slate-950 page looks the same and removes the compositing layer entirely.
//
// The brand emoji uses `text-2xl` (24px/32px) at every width, not
// `text-xl leading-none`: a 20px line box clips the hot dog glyph, whose ink
// extends past the em box. 32px of line height also keeps the header exactly
// 57px tall at all widths, which the game page's `top-14` balance bar assumes.

const LINKS = [
  { href: "/", label: "Server", key: "server" },
  { href: "/users", label: "Users", key: "users" },
  { href: "/compare", label: "Compare", key: "compare" },
  { href: "/numbers", label: "By the Numbers", key: "numbers" },
  { href: "/archive", label: "Archive", key: "archive" },
  { href: "/game", label: "Glizzy Clicker", key: "game" },
  { href: "/brawl", label: "GlizzyBrawl", key: "brawl" },
];

const BASE = "rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition";
const ACTIVE = "rounded-md text-white bg-accent/25 transition";

export function renderNav(active = "") {
  const desktop = LINKS.map(
    (l) =>
      `<a href="${l.href}" class="px-3 py-1.5 whitespace-nowrap ${l.key === active ? ACTIVE : BASE}">${l.label}</a>`,
  ).join("");
  const mobile = LINKS.map(
    (l) =>
      `<a href="${l.href}" class="block px-3 py-2 ${l.key === active ? ACTIVE : BASE}">${l.label}</a>`,
  ).join("");

  return `
  <header class="border-b border-slate-800/80 bg-slate-950 sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6">
      <div class="flex items-center justify-between gap-3 py-3">
        <a href="/" class="flex items-center gap-2 font-semibold shrink-0 whitespace-nowrap">
          <span class="text-2xl">🌭</span>
          <span class="text-slate-100 tracking-tight whitespace-nowrap">Hot Dog Hub</span>
        </a>
        <nav class="hidden md:flex items-center gap-1 text-sm">${desktop}</nav>
        <button type="button" id="nav-toggle" aria-label="Menu" aria-expanded="false"
          class="md:hidden shrink-0 p-1.5 -mr-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="block">
            <path d="M3 6h18M3 12h18M3 18h18"/>
          </svg>
        </button>
      </div>
      <nav id="nav-mobile" class="md:hidden hidden pb-3 text-sm">${mobile}</nav>
    </div>
  </header>
  <script>
    (function () {
      var btn = document.getElementById('nav-toggle');
      var panel = document.getElementById('nav-mobile');
      if (!btn || !panel) return;
      btn.addEventListener('click', function () {
        var open = panel.classList.toggle('hidden') === false;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    })();
  </script>`;
}
