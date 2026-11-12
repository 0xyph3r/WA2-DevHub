// Inline SVG icon set (24x24 viewBox, stroke-based). Applied to any
// element carrying data-icon="<name>".
const P = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  cube: P('<path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M12 12 21 7M12 12v10M12 12 3 7"/>'),
  layers: P('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>'),
  home: P('<path d="M3 11 12 3l9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>'),
  architecture: P('<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>'),
  modules: P('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  agents: P('<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13.5" r="1.2"/><circle cx="15" cy="13.5" r="1.2"/><path d="M9 17h6"/>'),
  tasks: P('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>'),
  git: P('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-9 5"/>'),
  database: P('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  api: P('<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>'),
  tests: P('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>'),
  deploy: P('<path d="M12 2c3 2 5 6 5 11l-5 4-5-4c0-5 2-9 5-11z"/><circle cx="12" cy="10" r="1.6"/><path d="M7 15l-3 3h4M17 15l3 3h-4"/>'),
  monitoring: P('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'),
  settings: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  search: P('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  bell: P('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>'),
  grid: P('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>'),
  help: P('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7"/><path d="M12 17h.01"/>'),
  'chevron-down': P('<path d="m6 9 6 6 6-6"/>'),
  menu: P('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  'chevron-right': P('<path d="m9 6 6 6-6 6"/>'),
  folder: P('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  'folder-open': P('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H6l-3 8z"/><path d="M3 18V7"/>'),
  file: P('<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>'),
  code: P('<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>'),
  fullscreen: P('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  link: P('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  play: P('<path d="M7 4v16l13-8z"/>'),
  deps: P('<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M7.3 11 16.7 7M7.3 13l9.4 4"/>'),
  activity: P('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M8 14l2 2 4-4"/>'),
  check: P('<path d="m5 12 5 5L20 7"/>'),
  'check-circle': P('<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 5-5"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  minus: P('<path d="M5 12h14"/>'),
  more: P('<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>'),
  close: P('<path d="M6 6l12 12M18 6 6 18"/>'),
  metrics: P('<circle cx="6" cy="6" r="1.5"/><circle cx="12" cy="6" r="1.5"/><circle cx="18" cy="6" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/><circle cx="6" cy="18" r="1.5"/><circle cx="12" cy="18" r="1.5"/><circle cx="18" cy="18" r="1.5"/>'),
  crown: P('<path d="m3 8 4 4 5-7 5 7 4-4-2 11H5z"/>'),
  flask: P('<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 15h9"/>'),
  rocket: P('<path d="M12 2c3 2 5 6 5 11l-5 4-5-4c0-5 2-9 5-11z"/><circle cx="12" cy="10" r="1.6"/><path d="M7 15l-3 3h4M17 15l3 3h-4M12 17v5"/>'),
  user: P('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  mobile: P('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
  laptop: P('<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>'),
  brain: P('<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V6a3 3 0 0 0-3-2z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1V6a3 3 0 0 1 3-2z"/>'),
  card: P('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 14h4"/>'),
  puzzle: P('<path d="M10 3a2 2 0 0 1 4 0v2h4v4h2a2 2 0 0 1 0 4h-2v4h-4v2a2 2 0 0 1-4 0v-2H6v-4H4a2 2 0 0 1 0-4h2V5h4z"/>'),
  atom: P('<circle cx="12" cy="12" r="1.5"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(120 12 12)"/>'),
  cloud: P('<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4 4 0 0 1 0 9z"/>'),
  box: P('<path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M12 12 21 7M12 12v10M12 12 3 7"/>'),
  terminal: P('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>'),
  eye: P('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  edit: P('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m13 7 4 4"/>'),
  book: P('<path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/>'),
  shield: P('<path d="M12 2 20 6v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/>'),
  image: P('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
  globe: P('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  zap: P('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  alert: P('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>'),
  stop: P('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  send: P('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  fork: P('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/>'),
};

export function applyIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (el.dataset.iconDone === name) return;
    el.innerHTML = ICONS[name] || ICONS.box;
    el.dataset.iconDone = name;
  });
}

export function icon(name, cls = '') {
  return `<span data-icon="${name}" data-icon-done="${name}" class="${cls}">${ICONS[name] || ICONS.box}</span>`;
}

/** Guess an icon for a directory or module name. */
export function iconForName(name) {
  const n = name.toLowerCase();
  const table = [
    [/mobile|ios|android|native|expo/, 'mobile'], [/web|www|site|frontend|front|client|ui|pages|views|app$/, 'laptop'],
    [/admin|backoffice|dashboard/, 'crown'], [/user|account|auth|portal|profile/, 'user'],
    [/ai|agent|llm|ml|model|brain|intelligence/, 'brain'], [/pay|billing|stripe|checkout|wallet|crypto/, 'card'],
    [/notif|mail|email|push|webhook|alert/, 'bell'], [/integr|plugin|extension|connector|hook/, 'puzzle'],
    [/api|server|service|backend|route|endpoint|graphql|rpc/, 'api'], [/db|database|prisma|migration|schema|sql|supabase|model/, 'database'],
    [/infra|docker|deploy|k8s|terraform|ci|ops|cloud/, 'cloud'], [/test|spec|e2e|__tests__|qa/, 'flask'],
    [/doc|readme|guide|wiki/, 'book'], [/lib|core|domain|logic|shared|common|util|pkg|packages/, 'box'],
    [/script|bin|tool|cli/, 'terminal'], [/asset|public|static|image|img|media/, 'image'],
    [/secur|guard|crypto|vault/, 'shield'], [/i18n|locale|lang|translation/, 'globe'], [/hook|worker|job|queue|event/, 'zap'],
    [/config|settings|env/, 'settings'], [/component|react|vue|svelte/, 'atom'],
  ];
  for (const [re, ic] of table) if (re.test(n)) return ic;
  return 'folder';
}

/** Short role label for a module name. */
export function roleForName(name) {
  const n = name.toLowerCase();
  const table = [
    [/mobile|ios|android|native/, 'Mobile app'], [/web|www|site|frontend|front|client|pages|views/, 'Web app'],
    [/admin|backoffice/, 'Admin area'], [/user|account|auth|portal/, 'User portal'],
    [/ai|agent|llm|ml/, 'AI & Agents'], [/pay|billing|stripe|checkout/, 'Payments'],
    [/notif|mail|email|push|webhook/, 'Notifications'], [/integr|plugin|extension|connector/, 'Integrations'],
    [/api|server|service|backend|route/, 'API & Services'], [/db|database|prisma|migration|schema|sql/, 'Database'],
    [/infra|docker|deploy|k8s|terraform|ci|ops/, 'Infrastructure'], [/test|spec|e2e|qa/, 'Tests & Quality'],
    [/doc|readme|guide/, 'Documentation'], [/lib|core|domain|logic|shared|common|util/, 'Business logic'],
    [/script|bin|tool|cli/, 'Tools'], [/asset|public|static|image|media/, 'Assets'],
    [/component|react|vue|svelte|ui/, 'UI components'], [/hook|worker|job|queue/, 'Background jobs'],
  ];
  for (const [re, label] of table) if (re.test(n)) return label;
  return 'Module';
}
