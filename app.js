'use strict';
const $ = (selector) => document.querySelector(selector);
const state = {
  token: localStorage.getItem('algo_arena_token') || localStorage.getItem('algo_token') || '',
  user: null, lobby: {rooms:[],leaderboard:[]}, room: null, view: 'lobby', queued: false,
  selectedCard: null, selectedNumber: null, busy: false, polling: false,
  resultShown: new Set(), authResolve: null, accountMode: 'login', chatSignature: '',
  history: [], roomReceivedAt: 0,
};
const labels = {lobby:'対戦ロビー',ranking:'ランキング',history:'対戦履歴',rules:'遊び方',game:'対戦ルーム'};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (value) => Number(value || 0).toLocaleString('ja-JP');
const initial = (name) => Array.from(name || 'G')[0].toUpperCase();
const modeLabel = (mode) => ({rated:'ランク',casual:'カジュアル',bot:'AI練習'}[mode] || 'カジュアル');
const modeEnglish = (mode) => ({rated:'RANKED MATCH',casual:'CASUAL MATCH',bot:'AI PRACTICE'}[mode] || 'CASUAL MATCH');
const clockLabel = (seconds) => `${seconds / 60}分＋${seconds === 600 ? 10 : 5}秒`;
const rankTitle = (rating) => rating >= 1900 ? 'GRANDMASTER' : rating >= 1800 ? 'MASTER' : rating >= 1700 ? 'EXPERT' : 'PLAYER';
const setText = (selector, value) => { const element = $(selector); if(element) element.textContent = value; };
function toast(message) { setText('#toast', message); $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 4800); }
function connected(ok, message) {
  $('#connection-status').classList.toggle('offline', !ok);
  setText('#connection-status span', ok ? '接続中' : '接続を確認');
  $('#connection-notice').hidden = ok;
  if(!ok) setText('#connection-message', message || 'サーバーに接続できません。再接続をお試しください。');
}
class ApiError extends Error { constructor(message,status,code) { super(message); this.status=status; this.code=code; } }
async function api(path, options={}) {
  const requestToken=state.token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(path, { ...options, headers:{'Content-Type':'application/json', ...(requestToken?{Authorization:`Bearer ${requestToken}`}:{})}, signal:controller.signal });
  } catch(error) {
    connected(false);
    throw new ApiError('接続できませんでした。ネットワークを確認して、もう一度お試しください。',0,'NETWORK');
  } finally { clearTimeout(timeout); }
  let data;
  try { data = await response.json(); } catch { connected(false,'サーバーの応答を読み取れませんでした。再接続をお試しください。'); throw new ApiError('サーバーの応答を読み取れませんでした。',response.status,'RESPONSE'); }
  connected(response.status<500,response.status>=500?'サーバーに接続できません。しばらくして再接続してください。':undefined);
  if(!response.ok) {
    if(response.status===401 && data.code==='AUTH_REQUIRED' && state.token===requestToken) { state.token=''; state.user=null; state.queued=false; localStorage.removeItem('algo_arena_token'); localStorage.removeItem('algo_token'); renderProfile(); }
    throw new ApiError(data.error || '操作を完了できませんでした。',response.status,data.code);
  }
  return data;
}
const post = (path,body={}) => api(path,{method:'POST',body:JSON.stringify(body)});
function openDialog(id) { const dialog=$(`#${id}`); if(!dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog=$(`#${id}`); if(dialog.open) dialog.close(); }
function setSession(result) {
  if(state.user && state.user.id!==result.user.id) {state.room=null;state.queued=false;resetSelection();showView('lobby');}
  state.token=result.token; state.user=result.user;
  localStorage.setItem('algo_arena_token',state.token); localStorage.removeItem('algo_token');
  renderProfile();
}
async function ensureAuth() {
  if(state.user) return true;
  if(state.token) { try { const data=await api('/api/me'); state.user=data.user; state.queued=Boolean(data.queued); renderProfile(); return true; } catch(error) { if(error.status!==401) { toast(error.message); return false; } } }
  openDialog('guest-dialog');
  return new Promise(resolve => { state.authResolve=resolve; });
}
function resolveAuth(value) { const resolve=state.authResolve; state.authResolve=null; if(resolve) resolve(value); }
function showView(view, {focus=false}={}) {
  if(!labels[view]) return;
  state.view=view;
  document.querySelectorAll('.view').forEach(element => element.hidden=element.id!==`view-${view}`);
  document.querySelectorAll('.nav-item').forEach(element => { const active=element.dataset.view===view; element.classList.toggle('active',active); if(active) element.setAttribute('aria-current','page'); else element.removeAttribute('aria-current'); });
  setText('#page-label',labels[view]);
  document.title = `${labels[view]} — ALGO ARENA`;
  if(view==='history') loadHistory();
  if(view==='ranking') renderLeaderboard();
  if(view==='game') renderGame();
  if(focus) { window.scrollTo({top:0,behavior:'smooth'}); const heading=$(`#view-${view} h1`); heading.tabIndex=-1; heading.focus({preventScroll:true}); }
}
function renderProfile() {
  const user=state.user;
  setText('#header-avatar',initial(user?.username)); setText('#header-username',user?.username || 'ゲストで入室');
  setText('#rating-avatar',initial(user?.username)); setText('#rating-name',user?.username || 'ゲストプレイヤー');
  setText('#rating-guest-label',user ? `${user.guest?'ゲスト':'登録プレイヤー'} / ${rankTitle(user.rating)}` : '入室して対戦をはじめよう');
  $('#my-rating').innerHTML=`${user?number(user.rating):'—'}<small>RATE</small>`;
  setText('#rating-caption',user ? `最高レート ${number(user.highestRating || user.rating)}` : 'スタートレート 1,500');
  setText('#my-games',user?number(user.games):'—');
  setText('#my-winrate',user?.games?`${Math.round(user.wins/user.games*100)}%`:'—');
  $('#rating-action').innerHTML=user ? `${user.guest?'アカウントを保存':'プレイヤー設定'} <span>→</span>` : 'ゲストで入室 <span>→</span>';
  $('#rating-action').dataset.action=user?.guest?'register':'profile';
  const accountSave=$('#profile-account-save'); if(accountSave) accountSave.hidden=!user?.guest;
  renderQueue();
}
function renderQueue() {
  $('#ranked-button').hidden=state.queued;
  $('#queue-state').hidden=!state.queued;
}
function emptyMarkup(title,description,action='') { return `<div class="empty-state"><span class="empty-icon">⌑</span><strong>${esc(title)}</strong><p>${esc(description)}</p>${action}</div>`; }
function renderLobby() {
  setText('#online-count',state.lobby.onlineCount ?? '—');
  const rooms=state.lobby.rooms || [];
  setText('#room-count',rooms.length);
  const signature=JSON.stringify(rooms);
  if(signature!==renderLobby.signature) {
    renderLobby.signature=signature;
    $('#room-list').innerHTML=rooms.length ? rooms.map(room => {
      const host=room.players?.[0]; const observing=room.status==='playing';
      return `<div class="room-row"><div class="room-player"><span class="avatar">${esc(initial(host?.username))}</span><div class="room-player-info"><strong>${esc(room.name)}</strong><small>${esc(host?.username || 'プレイヤー')} · ${number(host?.rating)} RATE${observing?' · 対戦中':''}</small></div></div><span class="tag ${room.mode==='rated'?'rated':''}">${esc(modeLabel(room.mode))}</span><span class="muted" title="${esc(clockLabel(room.timeSeconds))}">${room.timeSeconds/60}分</span><button class="join-button" data-action="${observing?'observe':'join-room'}" data-room-id="${esc(room.id)}">${observing?'観戦':'参加'} ↗</button></div>`;
    }).join('') : emptyMarkup('最初の一局を、ここから。','対戦相手を待っているルームはまだありません。','<button class="text-button" data-action="create-room">ルームをつくる <span>→</span></button>');
  }
  let banner=$('#active-room-banner');
  if(!banner) { banner=document.createElement('div'); banner.id='active-room-banner';banner.className='active-room-banner';$('.lobby-layout').before(banner); }
  banner.hidden=!state.room || state.room.status==='finished' || state.room.spectator;
  if(!banner.hidden) banner.innerHTML=`<span>${state.room.status==='waiting'?'対戦相手を待っているルームがあります。':'対戦が進行中です。'}</span><button class="text-button" data-action="resume">ルームに戻る →</button>`;
  if(state.view==='ranking') renderLeaderboard();
}
function renderLeaderboard() {
  const players=state.lobby.leaderboard || [];
  $('#leaderboard-list').innerHTML=players.length ? `<div class="leader-row header"><span>順位</span><span>プレイヤー</span><span>レート / 最高</span><span>勝率</span></div>${players.map((player,index)=>`<div class="leader-row ${player.id===state.user?.id?'you':''}"><span class="leader-rank">${String(index+1).padStart(2,'0')}</span><span class="leader-person"><span class="avatar">${esc(initial(player.username))}</span><strong>${esc(player.username)}${player.id===state.user?.id?'<small>あなた</small>':''}<small>${player.rating>=1700?rankTitle(player.rating):''}</small></strong></span><span class="leader-rating">${number(player.rating)}<small class="ranking-highest">${number(player.highestRating || player.rating)}</small></span><span class="muted small">${player.games?Math.round(player.wins/player.games*100)+'%':'—'}<small class="ranking-highest">${number(player.games)}局</small></span></div>`).join('')}` : emptyMarkup('ランキングは、これから。','ランク対戦をプレイすると、ここにレートが記録されます。');
}
async function loadHistory() {
  if(!state.user) { $('#history-list').innerHTML=emptyMarkup('あなたの一局目を、待っています。','ゲストで入室すると、対戦履歴を確認できます。','<button class="text-button" data-action="profile">ゲストで入室 →</button>'); return; }
  try {
    const data=await api('/api/history'); state.history=data.games || [];
    $('#history-list').innerHTML=state.history.length?state.history.map(game=>{
      const date=new Date(game.createdAt);const dateLabel=Number.isNaN(date.getTime())?'':date.toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return `<div class="history-row"><span class="history-result ${game.result==='loss'?'loss':''}">${game.result==='win'?'WIN':'LOSS'}</span><div class="history-person"><strong>vs. ${esc(game.opponent?.username || '対戦相手')}</strong><small>${esc(modeLabel(game.mode))} · ${esc(reasonLabel(game.reason))}</small></div><span class="history-delta ${game.ratingDelta<0?'negative':''}">${game.mode==='rated'?`${game.ratingDelta>0?'+':''}${game.ratingDelta}`:'—'}</span><span class="history-date">${esc(dateLabel)}</span></div>`;
    }).join(''):emptyMarkup('まだ、まっさらな対戦履歴。','最初の一局を遊ぶと、ここに結果が残ります。','<button class="text-button" data-view="lobby">対戦ロビーへ →</button>');
  } catch(error) { toast(error.message); }
}
function resetSelection() {state.selectedCard=null;state.selectedNumber=null;}
function setRoom(room,{navigate=false}={}) {
  if(!room) return;
  if(state.room?.id===room.id && room.version<state.room.version) return;
  if(state.room?.id!==room.id) { resetSelection(); state.chatSignature=''; $('#chat-messages').innerHTML='<p class="chat-empty">「よろしくお願いします」から。</p>'; }
  state.room=room;state.roomReceivedAt=Date.now();
  if(navigate) { showView('game',{focus:true}); const url=new URL(location.href);url.searchParams.set('room',room.id);history.replaceState({},'',url); }
  renderGame();renderLobby();
}
async function createRoom(body) {
  if(!await ensureAuth()) return;
  if(state.queued) { await api('/api/queue',{method:'DELETE'});state.queued=false;renderQueue(); }
  const result=await post('/api/rooms',body);setRoom(result.room,{navigate:true});
  closeDialog('room-dialog');
  await poll();
}
async function joinRoom(id) {
  if(!await ensureAuth()) return;
  try { const result=await post(`/api/rooms/${encodeURIComponent(id)}/join`);state.queued=false;setRoom(result.room,{navigate:true});await poll(); }
  catch(error) { if(error.status===409) { try { const result=await api(`/api/rooms/${encodeURIComponent(id)}`);if(result.room?.playerIds?.includes(state.user.id)) {setRoom(result.room,{navigate:true});return;} } catch {} } throw error; }
}
async function observeRoom(id) {if(!await ensureAuth()) return;const result=await api(`/api/rooms/${encodeURIComponent(id)}`);setRoom(result.room,{navigate:true});}
function reasonLabel(reason) {return {'all-revealed':'全カード公開',resigned:'投了',timeout:'時間切れ','time-out':'時間切れ'}[reason] || '対戦終了';}
function cardMarkup(card,index,{targetable=false,drawn=false}={}) {
  const tag=targetable?'button':'div';const color=card.color==='white'?'white':'black';
  const label=`${drawn?'この番に引いた':`${index+1}枚目の`}${color==='white'?'白':'黒'}のカード、${card.number===null?'数字は伏せられています':card.number}${card.revealed?'、公開済み':''}`;
  return `<${tag}${targetable?' type="button"':''} class="game-card ${color}${card.revealed?' revealed':''}${card.number===null?' is-hidden':''}${targetable?' targetable':''}${state.selectedCard===card.id?' selected':''}${drawn?' drawn':''}"${targetable?` data-action="select-card" data-card-id="${esc(card.id)}" aria-pressed="${state.selectedCard===card.id}"`:''} aria-label="${esc(label)}"><span class="card-corner">${color==='white'?'W':'B'}</span><span class="card-number">${card.number===null?'?':card.number}</span><span class="card-index">${drawn?'DRAW':String(index+1).padStart(2,'0')}</span></${tag}>`;
}
function renderGame() {
  const room=state.room;if(!room) return;
  const spectator=Boolean(room.spectator || (state.user && !room.playerIds?.includes(state.user.id)) || !state.user);
  setText('#game-kicker',`${modeEnglish(room.mode)} / ${clockLabel(room.timeSeconds)}${spectator?' / 観戦':''}`);
  setText('#game-title',room.name || '対戦ルーム');
  $('#leave-room-button').dataset.action=spectator?'return-lobby':'leave-room';
  setText('#leave-room-button',spectator?'観戦を終了':room.status==='playing'?'投了する':'ルームを退出');
  $('#waiting-panel').hidden=room.status!=='waiting';
  $('#playing-panel').hidden=!room.game;
  setText('#waiting-mode',`${modeLabel(room.mode)} / ${clockLabel(room.timeSeconds)} / ${room.private?'招待した人だけのルーム':'公開ルーム'}`);
  if(!room.game) return;
  const game=room.game; const ownId=game.yourPlayerId || (spectator?game.players[0]?.id:state.user?.id);
  const own=game.players.find(player=>player.id===ownId) || game.players[0];
  const opponent=game.players.find(player=>player.id!==own.id);
  if(!own || !opponent) return;
  const ownUser=room.players.find(player=>player.id===own.id); const opponentUser=room.players.find(player=>player.id===opponent.id);
  const yourTurn=!spectator && game.status==='playing' && game.currentPlayerId===own.id;
  if(!opponent.cards.some(card=>card.id===state.selectedCard && !card.revealed)) state.selectedCard=null;
  setText('#opponent-avatar',initial(opponentUser?.username));setText('#opponent-name',opponentUser?.username || '対戦相手');
  setText('#opponent-rating',opponentUser?.bot?'AI / 練習相手':`${number(opponentUser?.rating)} RATE`);
  setText('#own-avatar',initial(ownUser?.username));setText('#own-name',`${ownUser?.username || 'プレイヤー'}${spectator?'':'（あなた）'}`);
  setText('#own-rating',`${number(ownUser?.rating)} RATE`);
  let opponentCards=opponent.cards.map((card,index)=>cardMarkup(card,index,{targetable:yourTurn&&!card.revealed})).join('');
  let ownCards=own.cards.map((card,index)=>cardMarkup(card,index)).join('');
  if(game.drawnCard) { const markup=cardMarkup(game.drawnCard,0,{drawn:true}); if(game.currentPlayerId===own.id) ownCards+=markup; else opponentCards+=markup; }
  const cardSignature=JSON.stringify([ownCards,opponentCards]);
  if(renderGame.cardSignature!==cardSignature){$('#own-cards').innerHTML=ownCards;$('#opponent-cards').innerHTML=opponentCards;renderGame.cardSignature=cardSignature;}
  setText('#deck-count',game.deckCount);
  setText('#turn-number',`TURN ${String(game.turnNumber).padStart(2,'0')}`);
  const currentUser=room.players.find(player=>player.id===game.currentPlayerId);
  setText('#turn-status',game.status==='finished'?'対戦が終了しました':spectator?`${currentUser?.username || 'プレイヤー'}の番です`:yourTurn?'あなたの番です':'相手の番です');
  $('#turn-dot').style.background=yourTurn?'#62a076':'#b4bea5';
  setText('#attack-instruction',game.status==='finished'?`${reasonLabel(game.resultReason)}で決着。おつかれさまでした。`:spectator?'カードの並びと、2人の読み合いを見守ろう。':yourTurn?(game.canStay?'アタック成功！ 続けて推理するか、ステイで番を終えられます。':state.selectedCard?'数字を選んで、アタック。':'相手の伏せられたカードを1枚選んでください。'):'相手が推理しています。自分のカードを手がかりに、次の一手を考えよう。');
  document.querySelectorAll('.number-button').forEach(button=>{button.disabled=!yourTurn || state.busy;button.classList.toggle('selected',Number(button.dataset.number)===state.selectedNumber);button.setAttribute('aria-pressed',String(Number(button.dataset.number)===state.selectedNumber));});
  $('#attack-button').disabled=!yourTurn || !state.selectedCard || state.selectedNumber===null || state.busy;
  $('#stay-button').disabled=!yourTurn || !game.canStay || state.busy;
  setText('#action-hint',spectator?'観戦中はカードの選択やチャット送信はできません。':game.deckCount===0&&!game.drawnCard?'山札がありません。不正解だと自分の左端の伏せ札を公開します。':'当てたら続けてアタック可能。外すと引いたカードを公開して交代します。');
  setText('#game-mode-tag',room.mode==='rated'?'RANKED':room.mode==='bot'?'AI':'CASUAL');
  const logSignature=JSON.stringify(game.history);
  if(logSignature!==renderGame.logSignature) { renderGame.logSignature=logSignature;
    $('#game-log').innerHTML=(game.history || []).slice().reverse().map(event=>`<li class="${event.type==='attack'?(event.success?'success':'failure'):''}"><span class="log-turn">TURN ${String(event.turnNumber || 1).padStart(2,'0')}</span>${esc(eventLabel(event,room))}</li>`).join('');
  }
  $('#chat-input').disabled=spectator;$('#chat-form button').disabled=spectator;
  if(spectator) $('#chat-input').placeholder='参加者のみ送信できます'; else $('#chat-input').placeholder='メッセージを送る';
  renderClocks();
  if(game.status==='finished' && !state.resultShown.has(room.id)) {state.resultShown.add(room.id); if(!spectator) showResult(room);}
}
function eventLabel(event,room) {
  const actor=room.players.find(player=>player.id===event.actorId)?.username || 'プレイヤー';
  if(event.type==='start') return `${actor}の先手で対戦開始。`;
  if(event.type==='attack') { const target=room.game.players.flatMap(player=>player.cards).find(card=>card.id===event.targetCardId);return `${actor}：${target?.color==='white'?'白':'黒'}のカードに「${event.guess}」 → ${event.success?'正解！':'不正解。'}`; }
  if(event.type==='stay') return `${actor}がステイ。手番を交代。`;
  if(event.type==='resign') return `${actor}が投了しました。`;
  if(event.type==='timeout') return `${actor}が時間切れ。`;
  return '対戦の状況が更新されました。';
}
function renderClocks() {
  const room=state.room;if(!room?.game || !room.clocks) return;
  const game=room.game;const ownId=game.yourPlayerId || game.players[0].id;const opponentId=game.players.find(player=>player.id!==ownId)?.id;
  [[ownId,'#own-clock'],[opponentId,'#opponent-clock']].forEach(([id,selector])=>{
    let remaining=Number(room.clocks.remaining?.[id] ?? room.timeSeconds*1000);
    const running=game.status==='playing'&&room.clocks.runningPlayerId===id;
    if(running) remaining-=Math.max(0,Date.now()-state.roomReceivedAt);
    const seconds=Math.max(0,Math.ceil(remaining/1000));
    setText(selector,`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`);
    $(selector).classList.toggle('running',running);$(selector).classList.toggle('low',running&&seconds<30);
  });
}
function showResult(room) {
  const won=room.game.winnerId===state.user?.id;
  setText('#result-kicker',won?'WELL PLAYED.':'EVERY GAME IS A NEW LESSON.');
  setText('#result-emblem',won?'✦':'✧');setText('#result-title',won?'あなたの勝ち！':'次の一手につなげよう。');
  setText('#result-description',`${reasonLabel(room.game.resultReason)}で${won?'勝利しました':'対戦が終了しました'}。対戦ありがとうございました。`);
  const rating=room.ratingResult?.[state.user?.id];
  $('#result-rating').innerHTML=rating?`<small>YOUR RATING</small>${number(rating.after)}<b class="${rating.delta<0?'negative':''}">${rating.delta>0?'+':''}${rating.delta}</b>`:'<small>レートの変動はありません</small>GOOD GAME';
  openDialog('result-dialog');
}
async function gameAction(type) {
  if(state.busy || !state.room || state.room.spectator) return;
  state.busy=true;renderGame();
  try {
    const body={type,version:state.room.version};if(type==='attack'){body.targetCardId=state.selectedCard;body.guess=state.selectedNumber;}
    const result=await post(`/api/rooms/${encodeURIComponent(state.room.id)}/action`,body);resetSelection();setRoom(result.room);await poll();
  } catch(error) {toast(error.message);if(error.status===409) await poll();}
  finally {state.busy=false;renderGame();}
}
async function loadChat() {
  if(!state.room || state.room.status==='waiting' || state.room.spectator) return;
  const result=await api(`/api/rooms/${encodeURIComponent(state.room.id)}/chat`);
  const messages=result.messages || [];const signature=JSON.stringify(messages);
  if(signature===state.chatSignature) return;
  state.chatSignature=signature;
  const container=$('#chat-messages');const nearBottom=container.scrollTop+container.clientHeight>=container.scrollHeight-35;
  container.replaceChildren();
  if(!messages.length) {const empty=document.createElement('p');empty.className='chat-empty';empty.textContent='「よろしくお願いします」から。';container.append(empty);}
  messages.forEach(message=>{const row=document.createElement('div');row.className=`chat-message${message.userId===state.user?.id?' own':''}`;const name=document.createElement('strong');name.textContent=message.username;const text=document.createElement('span');text.textContent=message.text;row.append(name,text);container.append(row);});
  if(nearBottom) container.scrollTop=container.scrollHeight;
}
async function poll() {
  if(state.polling || document.hidden) return;
  state.polling=true;
  const pollToken=state.token;
  try {
    const requests=[api('/api/lobby')];if(state.token) requests.push(api('/api/me'));
    const results=await Promise.allSettled(requests);
    if(state.token!==pollToken) return;
    if(results[0].status==='fulfilled') state.lobby=results[0].value;
    let activeId;
    if(results[1]?.status==='fulfilled') {state.user=results[1].value.user;state.queued=Boolean(results[1].value.queued);activeId=results[1].value.activeRoomId;renderProfile();}
    if(activeId && activeId!==state.room?.id) { const result=await api(`/api/rooms/${encodeURIComponent(activeId)}`);setRoom(result.room,{navigate:true}); }
    else if(state.room) {const polledRoomId=state.room.id;const results=await Promise.allSettled([api(`/api/rooms/${encodeURIComponent(polledRoomId)}`),loadChat()]);if(state.room?.id===polledRoomId && state.token===pollToken && results[0].status==='fulfilled') setRoom(results[0].value.room);}
    renderLobby();
  } catch(error) {if(error.status!==401 && error.status!==0) toast(error.message);}
  finally {state.polling=false;}
}
async function leaveRoom() {
  if(!state.room) return;
  if(state.room.status==='playing'&&!state.room.spectator) {setText('#confirm-title','この対戦を投了しますか？');setText('#confirm-copy','投了すると、この対戦は敗北になります。ランク対戦ではレートが変動します。');openDialog('confirm-dialog');return;}
  await returnLobby();
}
async function returnLobby() {
  const room=state.room;
  if(room && room.status==='waiting' && !room.spectator) await post(`/api/rooms/${encodeURIComponent(room.id)}/leave`);
  state.room=null;resetSelection();closeDialog('result-dialog');closeDialog('confirm-dialog');
  const url=new URL(location.href);url.searchParams.delete('room');history.replaceState({},'',url);
  showView('lobby',{focus:true});await poll();
}
async function shareRoom() {
  if(!state.room) return;
  const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('room',state.room.id);
  try {await navigator.clipboard.writeText(url.href);toast('招待リンクをコピーしました。友だちに送って対戦しよう。');}
  catch {const dialog=document.createElement('dialog');dialog.className='dialog';const title=document.createElement('h2');title.textContent='招待リンク';const input=document.createElement('input');input.value=url.href;input.readOnly=true;input.setAttribute('aria-label','招待リンク');const button=document.createElement('button');button.className='button button-primary full';button.textContent='閉じる';button.addEventListener('click',()=>dialog.close());dialog.append(title,input,button);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();input.select();}
}
async function perform(action,element) {
  if(action==='profile') {if(!state.user) await ensureAuth();else {$('#profile-name').value=state.user.username;openDialog('profile-dialog');}}
  else if(action==='ranked') {if(!await ensureAuth()) return;const result=await post('/api/queue',{mode:'rated'});state.queued=Boolean(result.queued);renderQueue();if(result.roomId){const room=await api(`/api/rooms/${encodeURIComponent(result.roomId)}`);setRoom(room.room,{navigate:true});}else toast('対戦相手を探しています。相手が見つかると自動で始まります。');await poll();}
  else if(action==='cancel-queue') {await api('/api/queue',{method:'DELETE'});state.queued=false;renderQueue();toast('マッチングをキャンセルしました。');}
  else if(action==='bot') await createRoom({mode:'bot',timeSeconds:300});
  else if(action==='create-room') {if(await ensureAuth()) openDialog('room-dialog');}
  else if(action==='join-room') await joinRoom(element.dataset.roomId);
  else if(action==='observe') await observeRoom(element.dataset.roomId);
  else if(action==='refresh'||action==='retry') {await poll();if(action==='refresh') toast('対戦ルームを更新しました。');}
  else if(action==='select-card') {state.selectedCard=element.dataset.cardId;renderGame();}
  else if(action==='select-number') {state.selectedNumber=Number(element.dataset.number);renderGame();}
  else if(action==='attack'||action==='stay') await gameAction(action);
  else if(action==='share') await shareRoom();
  else if(action==='leave-room') await leaveRoom();
  else if(action==='return-lobby') await returnLobby();
  else if(action==='resume') showView('game',{focus:true});
  else if(action==='register'||action==='login') {state.accountMode=action;renderAccountMode();closeDialog('guest-dialog');closeDialog('profile-dialog');openDialog('account-dialog');}
  else if(action==='account-mode') {state.accountMode=element.dataset.mode;renderAccountMode();}
}
function renderAccountMode() {
  const register=state.accountMode==='register';
  setText('#account-title',register?(state.user?.guest?'このゲストを、保存しよう。':'アカウントをつくる'):'また、ここから一局。');
  setText('#account-copy',register?'名前とパスワードで、別の端末からもレートと履歴を引き継げます。':'保存したアカウントでログインしてください。');
  setText('#account-submit',register?'アカウントを作成':'ログイン');
  document.querySelectorAll('.account-tab').forEach(tab=>{const active=tab.dataset.mode===state.accountMode;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));});
  $('#account-password').autocomplete=register?'new-password':'current-password';
  $('#account-password').minLength=register?10:1;
  $('#account-password-note').hidden=!register;
  $('#account-error').hidden=true;
  if(register&&state.user?.guest) $('#account-name').value=state.user.username;
}
function formError(id,error) {setText(id,error.message);$(id).hidden=false;}
document.addEventListener('click',async(event)=>{
  const close=event.target.closest('[data-close]');if(close){closeDialog(close.dataset.close);return;}
  const view=event.target.closest('[data-view]');if(view){showView(view.dataset.view,{focus:true});return;}
  const element=event.target.closest('[data-action]');if(!element||element.disabled) return;
  const action=element.dataset.action;
  const blocking=!['profile','select-card','select-number','account-mode'].includes(action);
  if(blocking) element.disabled=true;
  try {await perform(action,element);}catch(error){toast(error.message || '操作を完了できませんでした。');}
  finally {if(blocking&&element.isConnected) element.disabled=false;}
});
$('#guest-dialog').addEventListener('close',()=>{if(!state.user && !$('#account-dialog')?.open) resolveAuth(false);});
$('#account-dialog')?.addEventListener('close',()=>{if(!state.user) resolveAuth(false);});
$('#guest-form').addEventListener('submit',async(event)=>{
  event.preventDefault();$('#guest-error').hidden=true;$('#guest-submit').disabled=true;
  try {const result=await post('/api/auth/guest',{username:$('#guest-name').value.trim() || undefined});setSession(result);resolveAuth(true);closeDialog('guest-dialog');await poll();}
  catch(error){formError('#guest-error',error);}finally{$('#guest-submit').disabled=false;}
});
$('#profile-form').addEventListener('submit',async(event)=>{
  event.preventDefault();$('#profile-error').hidden=true;const button=event.submitter;button.disabled=true;
  try {const result=await post('/api/profile',{username:$('#profile-name').value.trim()});state.user=result.user;renderProfile();closeDialog('profile-dialog');toast('プレイヤー名を変更しました。');await poll();}
  catch(error){formError('#profile-error',error);}finally{button.disabled=false;}
});
$('#room-form').addEventListener('submit',async(event)=>{
  event.preventDefault();$('#room-error').hidden=true;const button=event.submitter;button.disabled=true;const data=new FormData(event.currentTarget);
  try {await createRoom({name:data.get('name').trim() || undefined,mode:data.get('mode'),timeSeconds:Number(data.get('timeSeconds')),private:data.has('private')});}
  catch(error){formError('#room-error',error);}finally{button.disabled=false;}
});
$('#account-form')?.addEventListener('submit',async(event)=>{
  event.preventDefault();$('#account-error').hidden=true;const button=event.submitter;button.disabled=true;
  try {const result=await post(`/api/auth/${state.accountMode}`,{username:$('#account-name').value.trim(),password:$('#account-password').value});setSession(result);$('#account-password').value='';resolveAuth(true);closeDialog('account-dialog');toast(state.accountMode==='register'?'アカウントを保存しました。':'ログインしました。');await poll();}
  catch(error){formError('#account-error',error);}finally{button.disabled=false;}
});
$('#confirm-button').addEventListener('click',async()=>{closeDialog('confirm-dialog');await gameAction('resign');});
$('#chat-form').addEventListener('submit',async(event)=>{
  event.preventDefault();const input=$('#chat-input');const text=input.value.trim();if(!text||!state.room||state.room.spectator)return;
  const button=event.submitter;button.disabled=true;
  try {await post(`/api/rooms/${encodeURIComponent(state.room.id)}/chat`,{text});input.value='';await loadChat();$('#chat-messages').scrollTop=$('#chat-messages').scrollHeight;}
  catch(error){toast(error.message);}finally{button.disabled=false;input.focus();}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
window.addEventListener('online',()=>poll());
$('#number-grid').innerHTML=Array.from({length:12},(_,value)=>`<button class="number-button" data-action="select-number" data-number="${value}" aria-pressed="false" disabled>${value}</button>`).join('');
setInterval(()=>{if(!document.hidden)poll();},2000);
setInterval(()=>{if(!document.hidden)renderClocks();},300);
(async()=>{
  renderProfile();await poll();
  const roomId=new URL(location.href).searchParams.get('room');
  if(roomId && roomId!==state.room?.id) {
    try {await joinRoom(roomId);}catch(error){try {await observeRoom(roomId);toast('この対戦を観戦しています。');}catch{toast(error.message);}}
  }
})();
