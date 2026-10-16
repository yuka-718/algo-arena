const modal = document.querySelector('#game-modal');
const title = document.querySelector('#modal-title');
const copy = document.querySelector('#modal-copy');
const opponent = document.querySelector('#opponent-name');
const opponentRate = document.querySelector('#opponent-rate');
const opponents = [['mika.cards','1,808'],['ryo_logic','1,842'],['shun_4','1,790']];

function openMatch() {
  modal.classList.remove('hidden');
  title.innerHTML = '対戦相手を探しています<span class="loader">...</span>';
  copy.textContent = 'レートが近いプレイヤーとマッチング中。';
  opponent.textContent = 'SEARCHING'; opponentRate.textContent = '— RATE';
  setTimeout(() => { const found = opponents[Math.floor(Math.random()*opponents.length)]; opponent.textContent = found[0]; opponentRate.textContent = `${found[1]} RATE`; title.innerHTML = '対戦相手が見つかりました'; copy.textContent = '準備ができたら対戦を開始してください。'; }, 900);
}
function showRules() { document.querySelector('#how').scrollIntoView({behavior:'smooth'}); }
function startGame() {
  title.textContent = '相手のカードを推理しよう';
  copy.textContent = '相手の伏せられたカードから、数字を選んでください。';
  document.querySelector('.match-preview').innerHTML = `<div class="game-board"><div class="opponent-line"><span class="mini-avatar purple">M</span><span>mika.cards</span><span class="life">● ● ● ●</span></div><div class="hidden-cards"><button class="guess-card" data-action="guess" data-value="2">?</button><button class="guess-card" data-action="guess" data-value="4">?</button><button class="guess-card" data-action="guess" data-value="7">?</button><button class="guess-card" data-action="guess" data-value="9">?</button></div><div class="your-line"><span>あなたの手札</span><span class="my-cards"><b>01</b><b>04</b><b>08</b><b>12</b></span></div></div>`;
  document.querySelector('.full').textContent = 'カードを選ぶ';
  document.querySelector('.full').disabled = true;
}
function guessCard(button) {
  const right = button.dataset.value === '4';
  button.textContent = button.dataset.value;
  button.classList.add(right ? 'correct' : 'wrong');
  document.querySelector('.full').disabled = false;
  document.querySelector('.full').textContent = right ? '正解！ 次のカードへ' : '不正解… もう一度';
  copy.textContent = right ? '読み勝ち！ レート +24 のチャンス。' : '相手のカードはその数字ではありません。';
}
document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'play' || action === 'practice') openMatch();
  if (action === 'how') showRules();
  if (action === 'close') modal.classList.add('hidden');
  if (action === 'start-game') startGame();
  if (action === 'guess') guessCard(e.target.closest('[data-action="guess"]'));
  if (action === 'ranking') document.querySelector('#rank').scrollIntoView({behavior:'smooth'});
  if (action === 'profile') alert('プロフィール機能は次のアップデートで追加予定です。');
});
