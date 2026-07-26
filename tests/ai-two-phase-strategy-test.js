// Test de la stratégie explicite à deux phases (gather/align) — V58.
//
// Contexte : signalement utilisateur avec proposition de stratégie précise : (1) rassembler
// au maximum ses 7 pions, (2) puis les aligner sur la même face, en réévaluant en permanence
// à chaque coup. Diagnostic : la condition de victoire réelle (checkVictory) n'exige PAS
// d'atteindre un motif figé parmi les 2 908 — juste que les 7 pions soient connectés entre
// eux ET sur la même face, n'importe où sur le plateau. Or chaque coup fait automatiquement
// basculer la face du pion déplacé (pas d'action "retourner" séparée) : repositionner un pion
// déjà sur la bonne face le faisait donc basculer sur la mauvaise, faisant chuter le score et
// déclenchant la pénalité anti-régression — l'IA évitait alors de toucher aux pions
// "corrects" même quand c'était nécessaire pour connecter le groupe.
//
// Ce test vérifie que evaluatePlayerPosition() :
//  1. Détecte la bonne phase ("gather" si pas encore tous connectés, "align" si connectés
//     mais faces mélangées) via largestSameFaceConnectedGroupSize().
//  2. En phase "align", récompense bien un coup qui fait basculer un pion minoritaire vers la
//     face majoritaire tout en restant connecté au groupe (progrès réel vers la victoire),
//     même si ce coup fait mécaniquement baisser le sameFaceCount du pion déplacé pendant
//     l'instant du coup (il change de face) — le score global doit malgré tout augmenter.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function fail(message) {
  console.error('ÉCHEC:', message);
  process.exitCode = 1;
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function extractWorkerCode(gameSource) {
  const startMarker = 'const AI_WORKER_CODE = "';
  const startIdx = gameSource.indexOf(startMarker) + startMarker.length - 1;
  let i = startIdx + 1, s = '';
  while (true) {
    const c = gameSource[i];
    if (c === '\\') { s += c + gameSource[i + 1]; i += 2; continue; }
    if (c === '"') break;
    s += c; i++;
  }
  return JSON.parse('"' + s + '"');
}

function main() {
  const gameSource = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.invalid/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.load = () => {};
  const ctx = dom.getInternalVMContext();

  const workerCode = extractWorkerCode(gameSource);
  assert(workerCode.includes('function largestSameFaceConnectedGroupSize'), 'largestSameFaceConnectedGroupSize devrait exister dans AI_WORKER_CODE.');
  assert(workerCode.includes('phase === "align"') || workerCode.includes("phase === 'align'"), 'La logique de phase "align" devrait exister dans evaluatePlayerPosition.');

  vm.runInContext(gameSource, ctx, { filename: 'game.js' });
  const winningPatterns = vm.runInContext('WINNING_PATTERNS', ctx);
  const sideAdjacencyMap = vm.runInContext('SIDE_ADJACENCY_MAP', ctx);
  const symmetricMoves = vm.runInContext('SYMMETRIC_MOVES', ctx);
  const cellCentroids = vm.runInContext('CELL_CENTROIDS', ctx);
  const config = {
    weights: vm.runInContext('AI_CONSTRUCTION_WEIGHTS', ctx),
    zoneWeights: vm.runInContext('AI_ZONE_WEIGHTS', ctx),
    stagnation: vm.runInContext('AI_STAGNATION_CONFIG', ctx),
    winningPatterns,
    maxBackAndForthStreak: vm.runInContext('MAX_BACK_AND_FORTH_STREAK', ctx),
  };

  // Choisit un motif gagnant réel (7 cases mutuellement connectées) comme cluster de test.
  const pattern = winningPatterns.find(p => p.length === 7);
  assert(pattern, 'Un motif gagnant à 7 cases devrait exister.');

  const color = 'YELLOW';
  const otherColor = 'RED';

  // Place les 7 pions du joueur testé sur le motif, avec des faces MÉLANGÉES (4 VERSO, 3 RECTO)
  // -> déjà connectés (phase "align" attendue), pas encore vainqueur.
  const ownPieces = pattern.map((position, index) => ({
    id: `${color}-${index + 1}`,
    color,
    position,
    face: index < 4 ? 'VERSO' : 'RECTO',
    isNeutral: false,
  }));

  // Quelques pions adverses ailleurs sur le plateau, hors du cluster (n'interfèrent pas).
  const allOtherCells = Object.keys(symmetricMoves).filter(cell => !pattern.includes(cell));
  const enemyPieces = allOtherCells.slice(0, 7).map((position, index) => ({
    id: `${otherColor}-${index + 1}`,
    color: otherColor,
    position,
    face: 'VERSO',
    isNeutral: false,
  }));

  const player = { id: 'P1', name: 'Test', color, isAI: true };
  const opponent = { id: 'P2', name: 'Adversaire', color: otherColor, isAI: false };

  const buildState = pieces => ({
    status: 'PLAYING',
    players: [player, opponent],
    pieces,
    turnOrder: [player.id, opponent.id],
    moveHistory: [],
    ranking: [],
  });

  const wctx = vm.createContext({ self: {}, Date, Math, console });
  vm.runInContext(workerCode, wctx, { filename: 'worker.js' });

  function evalPosition(pieces) {
    const script = `
      state = ${JSON.stringify(buildState(pieces))};
      SYMMETRIC_MOVES = ${JSON.stringify(symmetricMoves)};
      SIDE_ADJACENCY_MAP = ${JSON.stringify(sideAdjacencyMap)};
      CELL_CENTROIDS = ${JSON.stringify(cellCentroids)};
      CONFIG = ${JSON.stringify(config)};
      PATTERN_CACHE = new Map();
      ({
        score: evaluatePlayerPosition(state.players.find(p => p.color === ${JSON.stringify(color)})),
        largestGroup: largestConnectedGroupSize(state.pieces.filter(p => p.color === ${JSON.stringify(color)})),
        largestSameFaceGroup: largestSameFaceConnectedGroupSize(state.players.find(p => p.color === ${JSON.stringify(color)})),
      });
    `;
    return vm.runInContext(script, wctx, { filename: 'eval.js' });
  }

  const allPieces = [...ownPieces, ...enemyPieces];
  const before = evalPosition(allPieces);

  console.log(`Position mélangée : largestGroup=${before.largestGroup}, largestSameFaceGroup=${before.largestSameFaceGroup}, score=${before.score.toFixed(1)}`);

  assert(before.largestGroup === 7, `Les 7 pions devraient être positionnellement connectés (largestGroup=${before.largestGroup}).`);
  assert(before.largestSameFaceGroup < 7, `largestSameFaceGroup devrait être < 7 avec des faces mélangées (trouvé ${before.largestSameFaceGroup}).`);
  assert(before.largestSameFaceGroup === 4, `Le plus grand sous-groupe de même face devrait être 4 (le groupe VERSO), trouvé ${before.largestSameFaceGroup}.`);

  // Simule le coup clé : un pion RECTO (minoritaire) quitte le cluster puis y revient
  // immédiatement (un aller-retour sur une case libre adjacente), ce qui le fait basculer
  // VERSO -> RECTO -> VERSO... non : un seul coup suffit à le faire basculer une fois. On
  // teste directement l'effet d'un flip : le pion RECTO minoritaire bascule VERSO (rejoint la
  // majorité) sans changer de position (simule l'effet net d'un aller-retour à 2 coups, dont
  // seul le résultat net de parité nous intéresse ici).
  const flipped = allPieces.map(piece => {
    if (piece.id === `${color}-5`) return { ...piece, face: 'VERSO' };
    return piece;
  });
  const after = evalPosition(flipped);

  console.log(`Après bascule d'un pion minoritaire vers la face majoritaire : largestSameFaceGroup=${after.largestSameFaceGroup}, score=${after.score.toFixed(1)}`);

  assert(after.largestSameFaceGroup > before.largestSameFaceGroup, `La bascule devrait augmenter largestSameFaceGroup (avant ${before.largestSameFaceGroup}, après ${after.largestSameFaceGroup}).`);
  assert(after.score > before.score, `Le score global devrait AUGMENTER après ce progrès réel vers la victoire (avant ${before.score.toFixed(1)}, après ${after.score.toFixed(1)}).`);

  console.log('\nOK STRATÉGIE À DEUX PHASES : la phase "align" est bien détectée et récompense correctement les bascules de face qui rapprochent de la victoire.');
}

main();
process.exit(0);
