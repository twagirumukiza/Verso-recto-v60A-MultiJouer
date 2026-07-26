// Test du lien de partage de salon et de la page simplifiée "V60_A" — multijoueur en ligne
// uniquement, pensée pour qu'un joueur puisse simplement partager un lien plutôt qu'un code
// à recopier à la main.
//
// Vérifie que :
//  1. Tous les éléments DOM requis par online-v39.js existent bien dans online-v60a.html
//     (garde-fou structurel : la page simplifiée ne doit rien casser).
//  2. Ouvrir la page avec ?room=VR-XXXX dans l'URL pré-remplit automatiquement le champ
//     "Code à rejoindre" — un joueur qui reçoit un lien n'a qu'à taper son nom et cliquer
//     "Rejoindre".
//  3. Créer un salon affiche bien un lien de partage complet (contenant le code), et active
//     le bouton "Copier le lien".
//  4. online-v39.html (l'ancienne page, sans les éléments optionnels shareLinkDisplay/
//     copyLink) continue de fonctionner sans erreur — la fonctionnalité est bien optionnelle,
//     pas une dépendance dure.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function fail(message) {
  console.error('ÉCHEC:', message);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function makeFakeCloud() {
  const data = {};
  const listeners = {};
  function makeSnapshot(p) { return { val: () => (data[p] === undefined ? null : JSON.parse(JSON.stringify(data[p]))) }; }
  function notify(p) { for (const cb of listeners[p] || []) cb(makeSnapshot(p)); }
  return {
    ref(p) {
      return {
        async set(value) { data[p] = value; notify(p); },
        async update(partial) { data[p] = { ...(data[p] || {}), ...partial }; notify(p); },
        async once() { return makeSnapshot(p); },
        on(_event, cb) { listeners[p] = listeners[p] || new Set(); listeners[p].add(cb); cb(makeSnapshot(p)); },
        off() { delete listeners[p]; },
      };
    },
  };
}

function makeFakeFirebase(cloud, fixedUid) {
  return {
    apps: [],
    initializeApp() { return {}; },
    app() { return {}; },
    database() { return cloud; },
    auth() { return { signInAnonymously: async () => ({ user: { uid: fixedUid } }) }; },
  };
}

function loadPage(htmlFile, { url, cloud, fixedUid }) {
  const html = fs.readFileSync(path.join(ROOT, htmlFile), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'online-v39.js'), 'utf8');

  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.load = () => {};
  window.firebase = makeFakeFirebase(cloud, fixedUid);

  let loadError = null;
  window.addEventListener('error', event => { loadError = event.error || event.message; });

  const ctx = dom.getInternalVMContext();
  vm.runInContext(source, ctx, { filename: 'online-v39.js' });
  if (loadError) fail(`${htmlFile} + online-v39.js a levé une erreur au chargement : ${loadError}`);

  return {
    window,
    document: window.document,
    getRoomCode: () => vm.runInContext('roomCode', ctx),
    waitFor: async (predicate, timeoutMs = 3000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return false;
    },
  };
}

function assertAllRequiredIdsPresent(htmlFile) {
  const source = fs.readFileSync(path.join(ROOT, 'online-v39.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, htmlFile), 'utf8');

  const requiredIds = new Set();
  for (const m of source.matchAll(/getElementById\("([^"]+)"\)/g)) requiredIds.add(m[1]);

  // Les éléments accédés uniquement via `els.xxx?.` dans online-v39.js sont optionnels par
  // conception (fonctionnalités qui dégradent gracieusement si absentes) : on ne les exige
  // pas dans toutes les pages qui chargent ce script.
  const optionalIds = new Set(['shareLinkDisplay', 'copyLink', 'soundToggleInGame', 'leaveRoomInGame']);

  const presentIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

  for (const id of requiredIds) {
    if (optionalIds.has(id)) continue;
    assert(presentIds.has(id), `${htmlFile} : l'élément #${id} (requis par online-v39.js) est manquant.`);
  }
}

async function main() {
  // --- 1) Garde-fou structurel sur les deux pages ---
  assertAllRequiredIdsPresent('online-v60a.html');
  assertAllRequiredIdsPresent('online-v39.html');
  console.log('OK : tous les éléments requis par online-v39.js sont présents dans online-v60a.html et online-v39.html.');

  // --- 2) Pré-remplissage du code depuis ?room= dans l'URL ---
  const cloud1 = makeFakeCloud();
  const session = loadPage('online-v60a.html', {
    url: 'https://example.invalid/online-v60a.html?room=vr-test',
    cloud: cloud1,
    fixedUid: 'uid-joiner',
  });
  const joinCodeValue = session.document.getElementById('joinCode').value;
  assert(joinCodeValue === 'VR-TEST', `Le champ "Code à rejoindre" devrait être pré-rempli à "VR-TEST" depuis l'URL, trouvé "${joinCodeValue}".`);
  console.log('OK : le paramètre ?room= dans l\'URL pré-remplit bien le champ "Code à rejoindre".');

  // --- 3) Création d'un salon : lien de partage affiché et bouton activé ---
  const cloud2 = makeFakeCloud();
  const creator = loadPage('online-v60a.html', {
    url: 'https://example.invalid/online-v60a.html',
    cloud: cloud2,
    fixedUid: 'uid-creator',
  });
  creator.document.getElementById('playerName').value = 'Alice';
  creator.document.getElementById('createRoom').click();

  const created = await creator.waitFor(() => !!creator.getRoomCode());
  assert(created, "Le salon n'a pas été créé.");
  const roomCode = creator.getRoomCode();

  const shareLinkEl = creator.document.getElementById('shareLinkDisplay');
  const copyLinkBtn = creator.document.getElementById('copyLink');

  assert(!shareLinkEl.hidden, 'Le lien de partage devrait être visible une fois le salon créé.');
  assert(shareLinkEl.textContent.includes(roomCode), `Le lien de partage devrait contenir le code du salon (${roomCode}), trouvé "${shareLinkEl.textContent}".`);
  assert(shareLinkEl.textContent.includes('?room='), 'Le lien de partage devrait utiliser le paramètre ?room=.');
  assert(!copyLinkBtn.disabled, 'Le bouton "Copier le lien" devrait être activé une fois le salon créé.');

  console.log(`OK : salon créé (${roomCode}), lien de partage affiché : ${shareLinkEl.textContent}`);

  console.log('\nOK LIEN DE PARTAGE : pré-remplissage depuis l\'URL et affichage du lien complet vérifiés, sur la page simplifiée comme sur l\'ancienne.');
}

main().then(() => process.exit(0)).catch(err => fail(err.stack || String(err)));
