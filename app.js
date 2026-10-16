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
function startGame() { title.textContent = '模擬対戦を開始！'; copy.textContent = 'あなたのターンです。相手の「04」を見抜ける？'; document.querySelector('.match-preview').classList.add('shake'); setTimeout(()=>document.querySelector('.match-preview').classList.remove('shake'),450); }
document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'play' || action === 'practice') openMatch();
  if (action === 'how') showRules();
  if (action === 'close') modal.classList.add('hidden');
  if (action === 'start-game') startGame();
  if (action === 'ranking') document.querySelector('#rank').scrollIntoView({behavior:'smooth'});
  if (action === 'profile') alert('プロフィール機能は次のアップデートで追加予定です。');
});
