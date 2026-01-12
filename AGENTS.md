# AGENTS.md（v0.1）— X自動投稿スケジューラ（GAS）

> 目的：このリポジトリで作業するAI開発エージェント（Gemini CLI / Codex）が、
> **安全に**・**事故なく**・**二重投稿なく** 実装を進めるための行動規範。

## 0. 絶対に守ること（最重要）

* **自動実行は禁止**：ここに書かれたコマンドや手順はすべて「例」。ユーザーの明示指示がない限り実行しない。
* **破壊的操作は禁止**：スプレッドシートの削除・全行削除・プロパティ全消去・プロジェクト上書き等は行わない。
* **シークレットは出力しない**：Client Secret / Access Token / Refresh Token / Script Properties の値をログやPRコメントに出さない。
* **二重投稿防止を最優先**：Lock + 状態遷移（queued→posting→posted/failed）+ 1回1件処理を崩さない。
* **未確定は埋めない**：不明点は `{{TODO: 未確定}}` として残し、質問する。

## 1. 進め方（推奨ワークフロー）

1. **認証で1回投稿成功**（最優先のリスク潰し）
2. スプレッドシートのPosts CRUD（作成/更新/一覧/状態遷移）
3. スケジューラ（トリガー）で1件処理 + Lock
4. UI（カレンダー：月→週）
5. failed通知と抑制

## 2. 技術スタック（確定/未確定）

* 確定

  * Google Apps Script（GAS）
  * Googleスプレッドシート
  * GAS Webアプリ（HTMLService）
  * カレンダーUI：FullCalendar（Standard想定）
  * 時刻：JST固定
  * 予約の過去日時：不可
  * failed通知：メール（MVP）
* 未確定

  * X API 認証方式：OAuth 1.0a
  * トリガー間隔：5分
  * ドラッグ&ドロップ：MVPに入れる

## 3. データモデル（Postsシート）

* id（UUID）
* scheduled_at（Date or ISO）
* text
* status（queued/posting/posted/failed/canceled）
* created_at / updated_at / posted_at
* tweet_id
* error
* last_attempt_at / attempt_count（任意）

## 4. 実装ガイド（GAS）

### 4.1 排他制御

* `LockService.getScriptLock()` を使用。
* ロック獲得できない場合は **何も投稿せず終了**（必要なら軽いログだけ）。

### 4.2 状態遷移の鉄則

* APIコール直前に必ず `queued → posting` を保存（原子的に）。
* 成功したら `posting → posted` + `tweet_id` + `posted_at`。
* 失敗したら `posting → failed` + `error` + `last_attempt_at`。
* **自動リトライしない**（読み取りなし運用の安全策）。再実行はUIで `failed → queued`。

### 4.3 posting残留の復旧

* 管理UIに「posting解除」機能（例：`posting → failed` にして理由を残す）を用意。

### 4.4 ログ

* 監査ログ（別シート）を使う場合：本文は必要最低限（先頭N文字）にする。
* 例外時のスタックトレースは可だが、トークン類が混入しないよう注意。

## 5. X API まわりの注意（変わりやすい前提）

* X APIの要件・プラン・上限は変わり得る。実装前に必ず公式ドキュメントを確認する。
* 使うエンドポイント：POST /2/tweets（テキスト投稿）
* スコープ：{{TODO: 採用する認証方式に応じて必要scope確定（例：tweet.write 等）}}

## 6. UI（Webアプリ）実装ポリシー

* まずは**月表示**で「件数＋先頭N文字＋色分け＋クリック編集」を完成させる。
* 次に週表示を有効化。
* 追加/編集はモーダル（datetime picker + 文字数カウンタ）。
* 過去日時はエラー。

## 7. Gemini CLI / Codex への指示テンプレ

* 「未確定」を見つけたら質問を最大5つに絞る。
* 変更は小さくコミット可能な単位で提案。
* GAS特有（トリガー/Lock/Properties）の落とし穴を先に列挙し、事故防止策を必ず書く。

## 8. 禁止事項（再掲）

* シート全削除、プロパティ全消去、トリガーの大量作成、権限を広げる変更を勝手に行わない。
* シークレットを出力しない。
* 自動実行しない。
