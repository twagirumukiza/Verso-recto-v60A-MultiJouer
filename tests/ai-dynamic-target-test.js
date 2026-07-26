// Test de stabilité de la cible du planificateur — V59.
//
// Contexte : l'utilisateur a fait remarquer, à juste titre, que la "mémoire des
// configurations gagnantes" (WINNING_PATTERNS, 2 908 motifs figés) pouvait empêcher l'IA de
// construire sa propre stratégie : closestWinningPatternForPlayer() recalculait le motif "le
// plus proche" à CHAQUE appel, sans aucune mémoire d'un appel à l'autre, et ce motif pouvait
// changer d'identité (7 cases totalement différentes) entre deux positions quasi identiques.
// breakoutTargetCells() ciblait ces cases, donc un pion pouvait viser une case un tour, puis
// une case totalement différente le tour suivant.
//
// Correctif : breakoutTargetCells() cible maintenant la FRONTIÈRE du plus grand groupe RÉEL
// du joueur (cases libres adjacentes à ce groupe), qui ne dépend que de la position actuelle
// des propres pièces du joueur — jamais de WINNING_PATTERNS.
//
// Ce test vérifie que :
//  1. Les cases renvoyées par breakoutTargetCells() sont bien adjacentes au plus grand groupe
//     du joueur (propriété structurelle attendue de la "frontière").
//  2. breakoutTargetCells() reste IDENTIQUE si on vide complètement WINNING_PATTERNS (preuve
//     d'indépendance vis-à-vis de la liste figée, tant que le groupe n'est pas déjà complet).
//  3. Un petit changement ailleurs sur le plateau (un pion adverse qui bouge, sans toucher au
//     groupe du joueur testé) ne change PAS la cible — stabilité, contrairement à l'ancien
//     comportement basé sur closestWinningPatternForPlayer.

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
  vm.runInContext(gameSource, ctx, { filename: 'game.js' });

  const workerCode = extractWorkerCode(gameSource);
  assert(!workerCode.includes('const best = closestWinningPatternForPlayer(player, state.pieces);\\n  if (!best) return [];\\n  const ownPositions'),
    'breakoutTargetCells ne devrait plus dépendre directement de closestWinningPatternForPlayer en premier recours.');
  assert(workerCode.includes('function breakoutTargetCells'), 'breakoutTargetCells devrait exister.');

  const symmetricMoves = vm.runInContext('SYMMETRIC_MOVES', ctx);
  const sideAdjacencyMap = vm.runInContext('SIDE_ADJACENCY_MAP', ctx);
  const cellCentroids = vm.runInContext('CELL_CENTROIDS', ctx);
  const winningPatterns = vm.runInContext('WINNING_PATTERNS', ctx);

  // Construit une position réelle : 5 des 7 pions YELLOW déjà connectés en un groupe (même
  // face), 2 pions YELLOW isolés ailleurs. Quelques pions RED ailleurs, sans lien.
  const pattern = winningPatterns.find(p => p.length === 7);
  const clusterCells = pattern.slice(0, 5);
  const isolatedCells = Object.keys(symmetricMoves).filter(c => !pattern.includes(c)).slice(0, 2);
  const enemyCells = Object.keys(symmetricMoves).filter(c => !pattern.includes(c) && !isolatedCells.includes(c)).slice(2, 9);

  function buildPieces(enemyMoved) {
    const yellow = [
      ...clusterCells.map((position, i) => ({ id: `YELLOW-${i + 1}`, color: 'YELLOW', position, face: 'VERSO', isNeutral: false })),
      ...isolatedCells.map((position, i) => ({ id: `YELLOW-${i + 6}`, color: 'YELLOW', position, face: 'VERSO', isNeutral: false })),
    ];
    const red = enemyCells.map((position, i) => ({
      id: `RED-${i + 1}`,
      color: 'RED',
      // Le premier pion RED bouge d'une case (sans toucher au cluster YELLOW) selon enemyMoved.
      position: (i === 0 && enemyMoved) ? enemyMoved : position,
      face: 'VERSO',
      isNeutral: false,
    }));
    return [...yellow, ...red];
  }

  const player = { id: 'P1', name: 'Test', color: 'YELLOW', isAI: true };
  const opponent = { id: 'P2', name: 'Adversaire', color: 'RED', isAI: false };

  const wctx = vm.createContext({ self: {}, Date, Math, console });
  vm.runInContext(workerCode, wctx, { filename: 'worker.js' });

  function computeTargets(pieces, patternsOverride) {
    const script = `
      state = ${JSON.stringify({ status: 'PLAYING', players: [player, opponent], pieces, turnOrder: [player.id, opponent.id], moveHistory: [], ranking: [] })};
      SYMMETRIC_MOVES = ${JSON.stringify(symmetricMoves)};
      SIDE_ADJACENCY_MAP = ${JSON.stringify(sideAdjacencyMap)};
      CELL_CENTROIDS = ${JSON.stringify(cellCentroids)};
      CONFIG = { winningPatterns: ${JSON.stringify(patternsOverride)}, zoneWeights: ${JSON.stringify(vm.runInContext('AI_ZONE_WEIGHTS', ctx))} };
      PATTERN_CACHE = new Map();
      breakoutTargetCells(state.players.find(p => p.color === 'YELLOW'));
    `;
    return vm.runInContext(script, wctx, { filename: 'targets.js' });
  }

  const basePieces = buildPieces(null);
  const targetsWithPatterns = computeTargets(basePieces, winningPatterns);
  const targetsWithoutPatterns = computeTargets(basePieces, []);

  console.log(`Cibles avec WINNING_PATTERNS présent : ${JSON.stringify(targetsWithPatterns.sort())}`);
  console.log(`Cibles avec WINNING_PATTERNS vidé     : ${JSON.stringify(targetsWithoutPatterns.sort())}`);

  // --- 1) Les cases renvoyées sont bien adjacentes au plus grand groupe du joueur ---
  const clusterSet = new Set(clusterCells);
  for (const cell of targetsWithPatterns) {
    const isAdjacentToCluster = (sideAdjacencyMap[cell] || []).some(n => clusterSet.has(n))
      || clusterCells.some(c => (sideAdjacencyMap[c] || []).includes(cell));
    assert(isAdjacentToCluster, `La case cible ${cell} devrait être adjacente au groupe (frontière), pas une case arbitraire d'un motif figé.`);
  }

  // --- 2) Indépendance totale vis-à-vis de WINNING_PATTERNS ---
  assert(
    JSON.stringify(targetsWithPatterns.sort()) === JSON.stringify(targetsWithoutPatterns.sort()),
    'breakoutTargetCells devrait renvoyer EXACTEMENT les mêmes cases que WINNING_PATTERNS soit présent ou vidé (preuve d\'indépendance).'
  );

  // --- 3) Stabilité : un pion adverse qui bouge ailleurs ne change pas la cible ---
  const movedEnemyCell = (symmetricMoves[enemyCells[0]] || [])[0];
  assert(movedEnemyCell, 'Le pion adverse choisi pour ce test devrait avoir au moins un coup légal.');
  const piecesAfterEnemyMove = buildPieces(movedEnemyCell);
  const targetsAfterEnemyMove = computeTargets(piecesAfterEnemyMove, winningPatterns);

  console.log(`Cibles après déplacement d'un pion adverse sans rapport : ${JSON.stringify(targetsAfterEnemyMove.sort())}`);

  assert(
    JSON.stringify(targetsWithPatterns.sort()) === JSON.stringify(targetsAfterEnemyMove.sort()),
    'La cible ne devrait PAS changer suite à un coup adverse sans rapport avec le groupe du joueur (stabilité).'
  );

  console.log('\nOK CIBLE DYNAMIQUE : breakoutTargetCells vise bien la frontière du groupe réel du joueur, indépendamment de WINNING_PATTERNS, et reste stable.');
}

main();
process.exit(0);
