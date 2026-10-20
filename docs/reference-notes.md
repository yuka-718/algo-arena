# Blokee調査メモ

調査日: 2026-10-20（日本時間）。Blokeeにユーザー了承のうえゲスト `guest2336802` として入り、公開情報、ルーム作成、CPU対戦開始・投了、プレイヤー一覧をブラウザで確認しました。他の人へのチャット投稿はしていません。

## 実際に確認した仕様

| Blokeeで確認したこと | ALGO ARENAへの反映 |
| --- | --- |
| Play as Guestと通常のログイン・登録 | ゲスト参加、登録・ログイン、ブラウザ再接続 |
| Games / Forum / Players のタブ | 対戦ロビー / ランキング / 履歴 / 遊び方 |
| ロビー内ルームとJoin / Observe | 募集中への参加と公開対局の観戦 |
| New Roomで2人・4人、CPU人数を選択 | アルゴの2人対戦とAI対戦 |
| 5分＋5秒、10分＋10秒、20分＋20秒の設定 | 5分＋5秒、10分＋10秒 |
| ルームで待機しStart、Leave | 相手参加時に自動開始、待機中は退室可能 |
| 初期ゲストレート1500 | 初期レート1500 |
| 対戦中の両者の時計、投了、チャット | サーバー時計、投了、チャット |
| 終了後の手順を戻す・進める操作 | 手順ログの表示（盤面リプレイは未実装） |
| Expert1700 / Master1800 / Grandmaster1900 | 同じ表示区分 |
| Rating(highest)、Win%と対戦数のランキング | レート、最高レート、成績の表示 |

## レート計算の確認範囲

Blokeeの公開ルールへのコメントに、利用者による「Elo」「K=40」という説明がありました。開発者による現行アルゴリズムの確証ではありません。今回のCPU戦の投了後、ゲストの表示レートは1500のままでした。

ALGO ARENAは**独自に明示した仕様**としてElo1500/K40、2人ゼロサム、対人レート戦のみ更新を採用します。Blokeeと完全に同一の非公開計算式を再現したとは扱いません。

## 元にしたページ

- [Blokee](https://blokee.mattle.online/)
- [Blokee Games](https://blokee.mattle.online/lobby/rooms)
- [Blokee Players](https://blokee.mattle.online/lobby/players)
- [Blokee公開ルールとレートへのコメント](https://blokee.mattle.online/lobby/forum/topic/Z2bJJGnhgLqLRxKMm/blokus-game-rules)
- [アルゴ公式・カードと並び順](https://www.sansu-olympic.gr.jp/algo/how/howto.htm)
- [アルゴ公式・2人プレー](https://www.sansu-olympic.gr.jp/algo/how/2play/2play.htm)

サイトの画面とコードは独自実装です。Blokeeやアルゴの公式サービスとの提携を示すものではありません。オリジナルのアルゴ2人ルールが2ラウンドを1ゲームとする点、チップによる得点計算、および本サイトの山札切れの追加ルールはREADMEと遊び方で区別しています。
