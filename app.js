const modal = document.querySelector('#game-modal');
const title = document.querySelector('#modal-title');
const copy = document.querySelector('#modal-copy');
const opponent = document.querySelector('#opponent-name');
const opponentRate = document.querySelector('#opponent-rate');
const opponents = [['mika.cards','1,808'],['ryo_logic','1,842'],['shun_4','1,790']];
let activeMatchId = null;
let authToken = localStorage.getItem('algo_token');
let accountMode = 'login';
async function api(path, options={}) {
  try { const response = await fetch(path, {headers:{'content-type':'application/json', ...(authToken?{authorization:`Bearer ${authToken}`}:{})}, ...options}); if (!response.ok) return null; return await response.json(); } catch { return null; }
}

function openMatch() {
  modal.classList.remove('hidden');
  title.innerHTML = '対戦相手を探しています<span class="loader">...</span>';
  copy.textContent = 'レートが近いプレイヤーとマッチング中。';
  opponent.textContent = 'SEARCHING'; opponentRate.textContent = '— RATE';
  api('/api/matches',{method:'POST',body:JSON.stringify({mode:'rated'})}).then(result=>{ if(result?.match){activeMatchId=result.match.id; opponent.textContent=result.match.opponent; opponentRate.textContent=`${result.match.opponentRating} RATE`; } else { const found=opponents[Math.floor(Math.random()*opponents.length)]; opponent.textContent=found[0]; opponentRate.textContent=`${found[1]} RATE`; } title.innerHTML='対戦相手が見つかりました'; copy.textContent='準備ができたら対戦を開始してください。'; });
}
function showRules() { document.querySelector('#how').scrollIntoView({behavior:'smooth'}); }
function openAccount() { document.querySelector('#account-modal').classList.remove('hidden'); }
function closeAccount() { document.querySelector('#account-modal').classList.add('hidden'); }
async function submitAccount(event) {
  event.preventDefault(); const form=new FormData(event.currentTarget); const path=accountMode==='register'?'/api/auth/register':'/api/auth/login';
  const result=await api(path,{method:'POST',body:JSON.stringify({username:form.get('username'),password:form.get('password')})});
  document.querySelector('#account-copy').textContent=result?.token?'ログインしました。対戦履歴を保存できます。':(result?.error||'公開サイトではゲストモードも利用できます。');
  if(result?.token){authToken=result.token;localStorage.setItem('algo_token',authToken);closeAccount();}
}
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
  if (activeMatchId) api(`/api/matches/${activeMatchId}/guess`,{method:'POST',body:JSON.stringify({value:Number(button.dataset.value)})});
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
  if (action === 'profile') openAccount();
  if (action === 'close-account') closeAccount();
  if (action === 'register') {accountMode='register';document.querySelector('#account-form button[type="submit"]').innerHTML='アカウント作成 <b>→</b>';document.querySelector('#account-copy').textContent='ユーザー名とパスワードを登録してください。';}
  if (action === 'guest-login') api('/api/auth/guest',{method:'POST',body:JSON.stringify({username:'yuki_718'})}).then(result=>{if(result?.token){authToken=result.token;localStorage.setItem('algo_token',authToken);closeAccount();}else document.querySelector('#account-copy').textContent='ゲストモードで遊べます。';});
});
document.querySelector('#account-form').addEventListener('submit',submitAccount);
